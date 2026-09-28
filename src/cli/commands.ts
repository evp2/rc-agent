import { readFileSync } from "node:fs";

import { engineKindFor, type ConnectorConfig } from "../config";
import { createEngine } from "../engine/create";
import { ENGINE_KINDS, type EngineKind } from "../engine/types";
import { runFork } from "../fork";
import { printPairingQrCode } from "../qr";
import { RelayClient, SessionEndedError } from "../relay/client";
import { runConnector } from "../session/loop";
import { spawnDetached } from "../spawn";
import { isProcessAlive, liveConnector, logPath, readState, statePath, writeState } from "../state";
import { CONNECTOR_VERSION } from "../version";

/** Prints the share link, if this relay minted one -- absent against an older deployment. */
function printShareUrl(staticUrl: string | undefined): void {
  if (staticUrl) console.log(`Share (view + suggest, no secret needed):\n  ${staticUrl}\n`);
}

/**
 * Prints the short Control link -- the one to type when the QR above cannot be
 * scanned. Labelled as full access because it is: unlike the share link, this
 * one drives the agent, and anyone who reads it over a shoulder has it.
 */
function printControlUrl(controlUrl: string | undefined): void {
  if (controlUrl) console.log(`Control (full access -- do not share):\n  ${controlUrl}\n`);
}

/**
 * The phone URL, QR code, Control link, and share link -- the tail every
 * "here's your running connector" report ends with, whether the connector
 * was already running, was just started, or was just forked.
 */
function printConnectionReport(state: {
  phoneUrl: string;
  controlUrl?: string;
  staticUrl?: string;
}): void {
  console.log(`Open on your phone:\n  ${state.phoneUrl}\n`);
  printPairingQrCode(state.phoneUrl);
  printControlUrl(state.controlUrl);
  printShareUrl(state.staticUrl);
}

const ENGINE_LABEL: Record<EngineKind, string> = { claude: "Claude", copilot: "Copilot" };

/** Mentions a connector on the other Engine working in the same worktree, which the human has to keep off this one's files. */
function noteOtherEngine(config: ConnectorConfig): void {
  const own = engineKindFor(config.provider);
  for (const other of ENGINE_KINDS.filter((kind) => kind !== own)) {
    const live = liveConnector(config.projectDir, other);
    if (live) {
      console.log(`Note: a ${ENGINE_LABEL[other]} connector is also running in ${config.projectDir} (pid ${live.pid}).\n`);
    }
  }
}

export async function runForeground(config: ConnectorConfig): Promise<void> {
  const engine = engineKindFor(config.provider);
  const existing = liveConnector(config.projectDir, engine);
  if (existing && existing.pid !== process.pid) {
    throw new Error(
      `A ${ENGINE_LABEL[engine]} connector is already running for ${config.projectDir} (pid ${existing.pid}).\n` +
        `Stop it with 'rc-agent stop' first, or check it with 'rc-agent status'.`,
    );
  }

  noteOtherEngine(config);
  const handle = await runConnector(config);
  console.log(
    `Session ${handle.sessionId} ${handle.resumed ? "resumed" : "created"} for ${config.projectDir}`,
  );
  console.log(`Open on your phone:\n  ${handle.phoneUrl}\n`);
  printPairingQrCode(handle.phoneUrl);
  printControlUrl(handle.controlUrl);
  printShareUrl(handle.staticUrl);
  console.log("");
  await handle.done;
}

/**
 * Spawns a detached copy of this process in `run` mode and waits for it to
 * publish a session to the state file.
 *
 * The state file is the handoff: the child's stdout goes to a log, so the
 * parent cannot scrape it for the phone URL the way a foreground run prints it.
 */
export async function start(config: ConnectorConfig, configPath: string): Promise<void> {
  const engine = engineKindFor(config.provider);
  const existing = liveConnector(config.projectDir, engine);
  if (existing) {
    console.log(`${ENGINE_LABEL[engine]} is already running for ${config.projectDir} (pid ${existing.pid}).`);
    printConnectionReport(existing);
    return;
  }

  noteOtherEngine(config);
  let state;
  try {
    state = await spawnDetached(config, configPath);
  } catch (e) {
    const log = logPath(config.projectDir, engine);
    throw new Error(`${(e as Error).message}\n\n${tailLog(log, 20)}`);
  }
  console.log(`Connector started for ${config.projectDir} (pid ${state.pid}).`);
  console.log(`Logging to ${logPath(config.projectDir, engine)}`);
  printConnectionReport(state);
}

/**
 * Creates a new Session in a new git Worktree of `config.projectDir`'s repo
 * and starts it, printing the same start-up report `rc-agent start` does.
 */
export async function fork(
  config: ConnectorConfig,
  name: string,
  fromRef: string | undefined,
): Promise<void> {
  const engine = createEngine(config);
  const conversationId = readState(config.projectDir, engine.kind)?.conversationId;
  const state = await runFork(config, engine, conversationId, name, fromRef);
  console.log(`Connector started for ${state.projectDir} (pid ${state.pid}).`);
  console.log(`Logging to ${logPath(state.projectDir, state.engine)}`);
  printConnectionReport(state);
}

export async function stop(config: ConnectorConfig, end: boolean): Promise<void> {
  const engine = engineKindFor(config.provider);
  const state = readState(config.projectDir, engine);
  if (!state) {
    console.log(`No connector state for ${config.projectDir}. Nothing to stop.`);
    return;
  }

  if (isProcessAlive(state.pid)) {
    process.kill(state.pid, "SIGTERM");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && isProcessAlive(state.pid)) await sleep(200);
    console.log(
      isProcessAlive(state.pid)
        ? `Connector (pid ${state.pid}) did not exit within 15s; leaving it be.`
        : `Connector stopped (pid ${state.pid}).`,
    );
  } else {
    console.log(`No connector running for ${config.projectDir}.`);
  }

  if (!end) {
    console.log("Session left alive -- 'rc-agent start' will resume it, no re-pair needed.");
    return;
  }

  // Ending is done here rather than in the connector so that a stop signal and
  // a deliberate end stay distinguishable: the connector never ends a session
  // just because it is exiting.
  try {
    const client = await RelayClient.resume(
      state.relayBaseUrl,
      state.sessionId,
      state.secret,
    );
    await client.end();
    console.log("Session ended. The phone will need to re-pair after the next start.");
  } catch (e) {
    if (e instanceof SessionEndedError) {
      console.log("Session had already ended.");
    } else {
      console.error("Failed to end the session:", (e as Error).message);
    }
  }
  writeState({ ...state, conversationId: undefined, commandCursor: undefined, inFlight: undefined });
}

/**
 * Reports both halves of health, because they fail independently: the local
 * process may be alive while the relay has not heard from it, and the session
 * may be perfectly valid with no process running at all.
 */
export async function status(config: ConnectorConfig): Promise<void> {
  const engine = engineKindFor(config.provider);
  const state = readState(config.projectDir, engine);
  console.log(`version       ${CONNECTOR_VERSION}`);
  console.log(`project dir   ${config.projectDir}`);
  console.log(`engine        ${ENGINE_LABEL[engine]}`);
  console.log(`state file    ${statePath(config.projectDir, engine)}`);
  console.log(`log file      ${logPath(config.projectDir, engine)}`);

  if (!state) {
    console.log(`process       not running (no state)`);
    console.log(`session       none -- 'rc-agent start' will create one`);
    return;
  }

  const alive = isProcessAlive(state.pid);
  console.log(`process       ${alive ? `running (pid ${state.pid})` : `not running (last pid ${state.pid})`}`);
  console.log(`started at    ${state.startedAt}`);
  if (state.lastError) console.log(`last error    ${state.lastError}`);
  if (config.inactivityCompact) {
    console.log(
      `auto-compact  enabled (${config.inactivityCompact.afterMinutes}m idle), ` +
        `last fired: ${state.lastAutoCompactAt ?? "never"}`,
    );
  }
  for (const entry of state.inFlight ?? []) {
    const fate =
      entry.status === "running"
        ? "will be reported as interrupted, not re-run"
        : "will be reported as dropped, never ran";
    console.log(`in flight     ${entry.seq} (${fate})`);
  }

  try {
    const client = await RelayClient.resume(
      state.relayBaseUrl,
      state.sessionId,
      state.secret,
    );
    const session = await client.getSession();
    const lastSeen = session.last_connector_seen_at;
    const ageMs = lastSeen ? Date.now() - Date.parse(lastSeen) : undefined;
    console.log(`session       ${state.sessionId} (alive)`);
    console.log(
      `relay sees    ${
        ageMs === undefined
          ? "never heard from this connector"
          : `${Math.round(ageMs / 1000)}s since last contact${ageMs < 15_000 ? "" : " -- the phone will treat it as unreachable"}`
      }`,
    );
    console.log(`phone url     ${state.phoneUrl}`);
    if (state.controlUrl) console.log(`control url   ${state.controlUrl}`);
    if (state.staticUrl) console.log(`share url     ${state.staticUrl}`);
  } catch (e) {
    if (e instanceof SessionEndedError) {
      console.log(`session       ${state.sessionId} (ended -- next start rotates, phone must re-pair)`);
    } else {
      console.log(`session       unknown -- relay unreachable: ${(e as Error).message}`);
    }
  }

  if (!alive) {
    console.log(`\nStart it with 'rc-agent start'.`);
    const tail = tailLog(logPath(config.projectDir, engine), 15);
    if (tail) console.log(`\nLast log lines:\n${tail}`);
  }
}

/**
 * Re-renders the pairing code for the *current* session. This is the lossless
 * path: a phone that pairs to a session it already had gets its whole
 * transcript back. Rotating is deliberately not offered here -- it is
 * `rc-agent stop --end` followed by `rc-agent start`.
 *
 * Defaults to the pairing QR (Control, embedded secret) -- this command
 * overwhelmingly exists to re-pair a device the user themselves controls, and
 * that device wants full access, not the read-plus-Suggest a share link now
 * grants. `--share` switches to the Netlify share link instead, for handing
 * to someone else to watch and weigh in on.
 */
export async function qr(config: ConnectorConfig, showShare: boolean): Promise<void> {
  const engine = engineKindFor(config.provider);
  const state = readState(config.projectDir, engine);
  if (!state) {
    throw new Error(
      `No session for ${config.projectDir}. Start one with 'rc-agent start'.`,
    );
  }

  let client: RelayClient | undefined;
  try {
    client = await RelayClient.resume(state.relayBaseUrl, state.sessionId, state.secret);
  } catch (e) {
    if (e instanceof SessionEndedError) {
      throw new Error(
        `Session ${state.sessionId} has ended, so this code would not work.\n` +
          `Run 'rc-agent stop --end' then 'rc-agent start' for a new one -- note that ` +
          `discards the conversation.`,
      );
    }
    console.error(`Warning: could not verify the session: ${(e as Error).message}`);
  }

  if (!isProcessAlive(state.pid)) {
    console.log("Note: no connector is running, so the phone will stay blocked until 'rc-agent start'.\n");
  }

  if (showShare) {
    if (!state.staticUrl) {
      throw new Error("This session predates the share link -- no --share URL to print.");
    }
    console.log(state.staticUrl);
    return;
  }

  // A session started before control codes existed has none in its state file;
  // asking the relay mints one, so `rc-agent qr` is how an already-running session
  // gets its Control link without a restart.
  const controlUrl =
    state.controlUrl ?? (await client?.fetchControlUrl().catch(() => undefined));

  console.log(`Open on your phone:\n  ${state.phoneUrl}\n`);
  printPairingQrCode(state.phoneUrl);
  printControlUrl(controlUrl);
  printShareUrl(state.staticUrl);
}

function tailLog(path: string, lines: number): string {
  try {
    return readFileSync(path, "utf-8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
