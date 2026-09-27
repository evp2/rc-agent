/**
 * Contract test for the Copilot adapter: drives {@link CopilotEngine} against
 * the installed `copilot` CLI through the exactly-pinned `@github/copilot-sdk`.
 * Everything else under test/ replays recorded session events through a fake
 * runtime; this is the inverse, so a CLI or SDK bump that breaks the
 * adapter's assumptions fails here rather than on a developer's phone.
 *
 * Spends a few premium requests. Not part of `npm test`, which stays offline.
 * Run with `npm run test:contract`. Skipped when the CLI isn't installed or
 * signed in.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CopilotEngine } from "../../src/engine/copilot/adapter";
import { chooseRuntime, startCopilotRuntime } from "../../src/engine/copilot/runtime";
import type { EngineAnswer, EngineEvent, EngineSession } from "../../src/engine/types";
import type { CopilotProviderConfig } from "../../src/provider";

const PROVIDER: CopilotProviderConfig = { type: "copilot", model: "auto" };

/** The environment the installed-CLI path sees: no token, so only `copilot login` can authenticate it. */
const LOGIN_ONLY_ENV = { ...process.env, COPILOT_GITHUB_TOKEN: undefined };

function loginEngine(): CopilotEngine {
  return new CopilotEngine({ startRuntime: () => startCopilotRuntime(PROVIDER, LOGIN_ONLY_ENV), model: PROVIDER.model });
}

let signedInCheck: Promise<boolean> | undefined;

/** Checked once, on a runtime of its own that is stopped straight after. */
function signedIn(): Promise<boolean> {
  signedInCheck ??= (async () => {
    try {
      const runtime = await startCopilotRuntime(PROVIDER, LOGIN_ONLY_ENV);
      try {
        return (await runtime.authStatus()).isAuthenticated;
      } finally {
        await runtime.stop();
      }
    } catch {
      return false;
    }
  })();
  return signedInCheck;
}

const SKIP = "no signed-in `copilot` CLI -- run `copilot login` to exercise the Copilot contract";

function openOn(engine: CopilotEngine, projectDir: string, resume?: string): Promise<EngineSession> {
  return engine.open({
    projectDir,
    resume,
    onQuestion: () => new Promise<EngineAnswer>(() => undefined),
  });
}

const TIMED_OUT = Symbol("timed out");

async function collect(
  iterator: AsyncIterator<EngineEvent>,
  predicate: (e: EngineEvent) => boolean,
  timeoutMs = 120_000,
): Promise<EngineEvent[]> {
  const collected: EngineEvent[] = [];
  for (;;) {
    const raced = await Promise.race([
      iterator.next(),
      new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), timeoutMs)),
    ]);
    if (raced === TIMED_OUT) throw new Error(`timed out; collected so far: ${JSON.stringify(collected)}`);
    if (raced.done) throw new Error(`event stream ended; collected: ${JSON.stringify(collected)}`);
    collected.push(raced.value);
    if (predicate(raced.value)) return collected;
  }
}

function workDir(): string {
  return mkdtempSync(join(tmpdir(), "crc-copilot-contract-"));
}

test("CopilotEngine: with only `copilot login`, the installed CLI reaches an authenticated session and runs a Turn with token Usage and no dollars", async (t) => {
  if (!(await signedIn())) return t.skip(SKIP);
  const session = await openOn(loginEngine(), workDir());
  const it = session.events[Symbol.asyncIterator]();
  session.send("Reply with the single word OK and nothing else.");
  const events = await collect(it, (e) => e.type === "turn_ended");
  await session.close();

  assert.ok(events.some((e) => e.type === "conversation"), "no conversation Event");
  assert.ok(events.some((e) => e.type === "announce"), "no announce Event");
  assert.deepEqual(
    events.filter((e) => e.type === "turn_started"),
    [{ type: "turn_started", cause: "command" }],
  );
  assert.ok(events.some((e) => e.type === "assistant_text"), "no assistant text");
  const ended = events.find((e) => e.type === "turn_ended") as Extract<EngineEvent, { type: "turn_ended" }>;
  assert.equal(ended.outcome, "success");
  assert.ok(ended.usage && ended.usage.outputTokens > 0, "a Copilot Turn carries token counts");
  assert.equal(ended.usage!.costUsd, undefined, "Copilot reports no dollars");
});

test("CopilotEngine: with COPILOT_GITHUB_TOKEN, the bundled runtime authenticates on the token", async (t) => {
  const token = process.env.COPILOT_GITHUB_TOKEN;
  if (!token) return t.skip("COPILOT_GITHUB_TOKEN is not set");
  assert.equal(chooseRuntime(PROVIDER).kind, "bundled");
  const engine = new CopilotEngine({ startRuntime: () => startCopilotRuntime(PROVIDER), model: PROVIDER.model });
  await engine.verify();
  const session = await openOn(engine, workDir());
  await session.close();
});

test("CopilotEngine: Stop ends the Turn promptly and cancels a detached shell started in it", async (t) => {
  if (!(await signedIn())) return t.skip(SKIP);
  const dir = workDir();
  const marker = join(dir, "detached-finished.txt");
  const session = await openOn(loginEngine(), dir);
  const it = session.events[Symbol.asyncIterator]();
  session.send(
    `Use the bash tool with mode "async" and detach true to start \`sleep 20 && echo finished > ${marker}\` ` +
      `as a detached shell, and do not wait for it. Then, with mode "sync", run \`sleep 60\` and wait for it. ` +
      `Then reply with just DONE.`,
  );
  const running = await collect(it, (e) => e.type === "tool_use" && JSON.stringify(e.input).includes("sleep 60"));
  assert.ok(
    running.some((e) => e.type === "tool_use" && (e.input as { detach?: boolean }).detach === true),
    "the model started the command as a Copilot detached shell, which is what this test is about",
  );
  const stoppedAt = Date.now();
  session.stop();
  const events = await collect(it, (e) => e.type === "turn_ended", 30_000);
  const ended = events.find((e) => e.type === "turn_ended") as Extract<EngineEvent, { type: "turn_ended" }>;
  assert.equal(ended.outcome, "stopped");
  assert.ok(Date.now() - stoppedAt < 10_000, "Stop ended the Turn promptly");

  // Past the detached shell's own finish time: had it survived the Stop, it
  // would have written the marker by now. Copilot reports the killed shell as
  // completed meanwhile, which would wake the agent into the stopped work.
  const afterStop: EngineEvent[] = [];
  const reading = (async () => {
    for (;;) {
      const next = await it.next();
      if (next.done) return;
      afterStop.push(next.value);
    }
  })();
  await new Promise((r) => setTimeout(r, 25_000));
  await session.close();
  await reading;
  assert.equal(existsSync(marker), false, "the detached shell did not survive the Stop");
  assert.deepEqual(
    afterStop.filter((e) => e.type === "turn_started"),
    [],
    "the killed shell's completion did not wake the agent back up",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("CopilotEngine: a Conversation resumes across a runtime restart and remembers earlier Turns", async (t) => {
  if (!(await signedIn())) return t.skip(SKIP);
  const dir = workDir();
  const first = await openOn(loginEngine(), dir);
  const firstEvents = first.events[Symbol.asyncIterator]();
  first.send("Remember this codeword for later: CONTRACT-OTTER-17. Reply with just OK.");
  const opened = await collect(firstEvents, (e) => e.type === "turn_ended");
  await first.close();
  const conversationId = (opened.find((e) => e.type === "conversation") as Extract<EngineEvent, { type: "conversation" }>).id;

  const second = await openOn(loginEngine(), dir, conversationId);
  const it = second.events[Symbol.asyncIterator]();
  second.send("What codeword did I ask you to remember? Reply with just the codeword.");
  const events = await collect(it, (e) => e.type === "turn_ended");
  await second.close();

  assert.deepEqual(events.find((e) => e.type === "conversation"), {
    type: "conversation",
    id: conversationId,
    resumed: true,
  });
  const said = events
    .filter((e) => e.type === "assistant_text")
    .map((e) => (e as { text: string }).text)
    .join(" ");
  assert.match(said, /CONTRACT-OTTER-17/);
});

test("CopilotEngine: a Conversation Copilot doesn't have opens fresh and is reported as lost", async (t) => {
  if (!(await signedIn())) return t.skip(SKIP);
  const session = await openOn(loginEngine(), workDir(), "00000000-0000-0000-0000-000000000000");
  const [conversation] = await collect(session.events[Symbol.asyncIterator](), (e) => e.type === "conversation");
  await session.close();
  assert.equal((conversation as Extract<EngineEvent, { type: "conversation" }>).resumed, false);
  assert.equal((conversation as Extract<EngineEvent, { type: "conversation" }>).lostPrevious, true);
});
