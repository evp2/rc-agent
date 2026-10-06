import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

import { engineKindFor, type ConnectorConfig } from "./config";
import { ensureStateDir, isProcessAlive, logPath, readState, type ConnectorState } from "./state";

// How long a spawned detached process is given to publish its own session to
// the state file before it's treated as having failed to start.
const SPAWN_TIMEOUT_MS = 45_000;
const SPAWN_POLL_MS = 250;

/**
 * Spawns a detached copy of this process in `run` mode against `config` and
 * waits for it to publish a session to its state file. `rc-agent start`
 * (cli/commands.ts) layers printing and the already-running check on top.
 *
 * The state file is the handoff: the child's stdout goes to a log, so the
 * caller cannot scrape it for the phone URL the way a foreground run prints
 * it.
 */
export async function spawnDetached(
  config: ConnectorConfig,
  configPath: string,
): Promise<ConnectorState> {
  const entry = process.argv[1];
  if (!entry || entry.endsWith(".ts")) {
    throw new Error(
      "Needs the built entrypoint -- run 'npm run build' and start via dist/index.js.",
    );
  }

  const engine = engineKindFor(config.provider);
  ensureStateDir();
  const log = logPath(config.projectDir, engine);
  const logFd = openSync(log, "a");
  const startedAt = Date.now();

  const child = spawn(process.execPath, [entry, "run", "--config", configPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: config.projectDir,
  });
  child.unref();
  closeSync(logFd);

  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readState(config.projectDir, engine);
    if (state && state.pid === child.pid && Date.parse(state.startedAt) >= startedAt - 1000) {
      return state;
    }
    if (child.pid && !isProcessAlive(child.pid)) break;
    await sleep(SPAWN_POLL_MS);
  }

  throw new Error(
    `Connector did not start within ${Math.round(SPAWN_TIMEOUT_MS / 1000)}s. Check the log: ${log}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
