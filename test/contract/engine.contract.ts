/**
 * Contract test for the Claude adapter: exercises {@link ClaudeEngine} against
 * the REAL, exactly-pinned `@anthropic-ai/claude-agent-sdk`, the same way
 * test/contract/sdk.contract.ts pins the raw SDK's own undocumented
 * behaviours. Everything else under test/ drives the adapter against a fake
 * `query()`; this is the inverse, so a real SDK bump that breaks the
 * adapter's assumptions fails here rather than on a developer's phone.
 *
 * Costs nothing to run: the probe below stops before the model is ever
 * invoked. Not part of `npm test`, which stays offline. Run with
 * `npm run test:contract`.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";

import { ClaudeEngine } from "../../src/engine/claude/adapter";
import type { EngineAnswer, EngineEvent } from "../../src/engine/types";
import { buildProviderEnv } from "../../src/engine/claude/providerEnv";

const execFileAsync = promisify(execFile);

/** The repo root -- a working directory with real project-scoped skills installed. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** See test/contract/sdk.contract.ts for why this is the credential check. */
async function credentialsAvailable(): Promise<boolean> {
  if (process.env.ANTHROPIC_API_KEY) return true;
  try {
    const { stdout } = await execFileAsync("claude", ["auth", "status"]);
    return JSON.parse(stdout).loggedIn === true;
  } catch {
    return false;
  }
}

function noQuestionsExpected() {
  return () => new Promise<EngineAnswer>(() => undefined);
}

const TIMED_OUT = Symbol("timed out");

async function collect(
  iterator: AsyncIterator<EngineEvent>,
  predicate: (e: EngineEvent) => boolean,
  timeoutMs = 60_000,
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

test("ClaudeEngine: a real Turn against the pinned SDK reports a Conversation, an announcement, and a successful outcome with usage", async (t) => {
  if (!(await credentialsAvailable())) {
    t.skip("no authenticated `claude` CLI -- run `claude login` to exercise the SDK contract");
    return;
  }

  const engine = new ClaudeEngine({ query: realQuery, env: buildProviderEnv({ type: "anthropic" }) });
  const session = await engine.open({ projectDir: REPO_ROOT, onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("Reply with the single word OK and nothing else.");

  const events = await collect(it, (e) => e.type === "turn_ended");
  await session.close();

  assert.ok(events.some((e) => e.type === "conversation"), "no conversation Event");
  assert.ok(events.some((e) => e.type === "announce"), "no announce Event");
  const ended = events.find((e) => e.type === "turn_ended") as Extract<EngineEvent, { type: "turn_ended" }>;
  assert.equal(ended.outcome, "success");
  assert.ok(ended.usage, "a successful Turn against the real SDK must carry Usage");
  assert.ok(ended.usage!.inputTokens > 0);
});

test("ClaudeEngine: Stop against the real SDK ends the Turn promptly", async (t) => {
  if (!(await credentialsAvailable())) {
    t.skip("no authenticated `claude` CLI -- run `claude login` to exercise the SDK contract");
    return;
  }

  const engine = new ClaudeEngine({ query: realQuery, env: buildProviderEnv({ type: "anthropic" }) });
  const session = await engine.open({ projectDir: REPO_ROOT, onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("Count slowly from 1 to 1000, one number per line, with no other text.");
  await collect(it, (e) => e.type === "turn_started");
  session.stop();

  const events = await collect(it, (e) => e.type === "turn_ended", 30_000);
  await session.close();

  const ended = events.find((e) => e.type === "turn_ended") as Extract<EngineEvent, { type: "turn_ended" }>;
  assert.ok(ended.outcome === "stopped" || ended.outcome === "success", `unexpected outcome: ${ended.outcome}`);
});

test("ClaudeEngine: an unresolvable resume opens fresh and is reported as a lost Conversation", async (t) => {
  if (!(await credentialsAvailable())) {
    t.skip("no authenticated `claude` CLI -- run `claude login` to exercise the SDK contract");
    return;
  }

  const engine = new ClaudeEngine({ query: realQuery, env: buildProviderEnv({ type: "anthropic" }) });
  const session = await engine.open({
    projectDir: REPO_ROOT,
    resume: "00000000-0000-0000-0000-000000000000",
    onQuestion: noQuestionsExpected(),
  });
  const it = session.events[Symbol.asyncIterator]();
  session.send("Reply with the single word OK and nothing else.");

  const events = await collect(it, (e) => e.type === "conversation");
  await collect(it, (e) => e.type === "turn_ended");
  await session.close();

  const conversation = events.find((e) => e.type === "conversation") as Extract<EngineEvent, { type: "conversation" }>;
  assert.equal(conversation.resumed, false);
  assert.equal(
    conversation.lostPrevious,
    true,
    "open() must never throw for a missing Conversation -- it should start fresh and say so",
  );
});
