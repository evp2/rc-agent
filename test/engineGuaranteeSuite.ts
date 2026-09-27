import assert from "node:assert/strict";
import { test } from "node:test";

import type { Engine, EngineAnswer, EngineEvent, EngineQuestion } from "../src/engine/types.ts";

/**
 * What a test harness supplies so the suite can drive each guarantee against
 * a real Engine instance, without knowing anything about which adapter it
 * is. Every factory returns a *fresh* Engine -- the suite opens and drives
 * each one itself.
 */
export interface EngineGuaranteeHarness {
  /** A Turn that finishes successfully on its own, with no interaction needed. */
  makeSimpleEngine(): Engine;
  /** A Turn that fails outright (a subprocess dying, a rejected promise, ...). */
  makeErroringEngine(): Engine;
  /** A Turn that never finishes on its own -- only `stop()` ends it. */
  makeHangingEngine(): Engine;
  /** A Turn that finishes on its own, followed by a second Turn that only begins once something is sent while the first has already ended. */
  makeQueueingEngine(): Engine;
  /** A Turn that hangs open until Steered, at which point a second (short, self-ending) Turn begins in its place. */
  makeSteerableEngine(): Engine;
  /** A Turn that starts one Background task (id `"bg-1"`) and then hangs open until `stop()` lands. */
  makeBackgroundTaskEngine(): Engine;
}

function openOptions(overrides: { resume?: string } = {}): {
  projectDir: string;
  resume?: string;
  onQuestion: (q: EngineQuestion, signal: AbortSignal) => Promise<EngineAnswer>;
} {
  return {
    projectDir: "/tmp/engine-guarantee-suite",
    ...overrides,
    onQuestion: () => new Promise<EngineAnswer>(() => undefined),
  };
}

const TIMED_OUT = Symbol("timed out");

/** Pulls from `iterator` until `predicate` matches an event, returning everything read (inclusive). Throws on timeout so a broken invariant fails fast rather than hanging the suite. */
async function readUntil(
  iterator: AsyncIterator<EngineEvent>,
  predicate: (e: EngineEvent) => boolean,
  timeoutMs = 2000,
): Promise<EngineEvent[]> {
  const collected: EngineEvent[] = [];
  for (;;) {
    const result = await Promise.race([
      iterator.next(),
      new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), timeoutMs)),
    ]);
    if (result === TIMED_OUT) {
      throw new Error(`timed out waiting for a matching event; collected so far: ${JSON.stringify(collected)}`);
    }
    if (result.done) throw new Error(`event stream ended before a matching event; collected: ${JSON.stringify(collected)}`);
    collected.push(result.value);
    if (predicate(result.value)) return collected;
  }
}

function turnStarted(e: EngineEvent): e is Extract<EngineEvent, { type: "turn_started" }> {
  return e.type === "turn_started";
}
function turnEnded(e: EngineEvent): e is Extract<EngineEvent, { type: "turn_ended" }> {
  return e.type === "turn_ended";
}

export function runEngineGuaranteeSuite(name: string, harness: EngineGuaranteeHarness): void {
  test(`${name}: an ordinary Turn starts and ends exactly once`, async () => {
    const session = await harness.makeSimpleEngine().open(openOptions());
    const it = session.events[Symbol.asyncIterator]();
    session.send("hello");
    const events = await readUntil(it, turnEnded);
    assert.equal(events.filter(turnStarted).length, 1);
    assert.equal(events.filter(turnEnded).length, 1);
    await session.close();
  });

  test(`${name}: a Turn that fails still ends exactly once`, async () => {
    const session = await harness.makeErroringEngine().open(openOptions());
    const it = session.events[Symbol.asyncIterator]();
    session.send("do something risky");
    const events = await readUntil(it, turnEnded);
    assert.equal(events.filter(turnStarted).length, 1);
    const ends = events.filter(turnEnded);
    assert.equal(ends.length, 1);
    assert.equal(ends[0].outcome, "error");
    await session.close();
  });

  test(`${name}: a Stopped Turn still ends exactly once`, async () => {
    const session = await harness.makeHangingEngine().open(openOptions());
    const it = session.events[Symbol.asyncIterator]();
    session.send("keep going");
    await readUntil(it, turnStarted);
    session.stop();
    const events = await readUntil(it, turnEnded);
    assert.equal(events.filter(turnStarted).length, 0, "no further Turn started while stopping this one");
    assert.equal(events.filter(turnEnded).length, 1);
    await session.close();
  });

  test(`${name}: Stop also ends a Command queued behind the stopped Turn, pairing its Turn as stopped`, async () => {
    const session = await harness.makeHangingEngine().open(openOptions());
    const it = session.events[Symbol.asyncIterator]();
    session.send("keep going");
    await readUntil(it, turnStarted);
    session.send("queued behind it");
    session.stop();
    let endedCount = 0;
    const events = await readUntil(it, (e) => {
      if (turnEnded(e)) endedCount += 1;
      return endedCount === 2;
    });
    const starts = events.filter(turnStarted);
    assert.equal(starts.length, 1, "the queued Command's Turn is reported, so whoever sent it hears how it ended");
    assert.equal(starts[0].cause, "command");
    assert.deepEqual(
      events.filter(turnEnded).map((e) => e.outcome),
      ["stopped", "stopped"],
    );
    await session.close();
  });

  test(`${name}: send() queues behind a running Turn and starts once it ends`, async () => {
    const session = await harness.makeQueueingEngine().open(openOptions());
    const it = session.events[Symbol.asyncIterator]();
    session.send("first");
    await readUntil(it, turnStarted);
    session.send("second");
    // The only way a second turn_started can arrive is after the first's
    // turn_ended -- if the fake or the adapter ever let it jump the queue,
    // this assertion (not a timeout) is what would catch it. Collected
    // rather than assumed adjacent, since a real Turn's own content
    // (assistant text, tool calls) sits between the two.
    const rest = await readUntil(it, turnStarted);
    assert.equal(rest.filter(turnStarted).length, 1, "no Turn started for the queued Command early");
    assert.equal(rest.filter(turnEnded).length, 1, "the first Turn's own outcome came before the second ever started");
    assert.equal((rest.find(turnStarted) as Extract<EngineEvent, { type: "turn_started" }>).cause, "command");
    await session.close();
  });

  test(`${name}: a delivered Steer ends the Turn, then starts a fresh one with cause "steer"`, async () => {
    const engine = harness.makeSteerableEngine();
    const session = await engine.open(openOptions());
    if (!engine.capabilities.steer) {
      await session.close();
      return;
    }
    const it = session.events[Symbol.asyncIterator]();
    session.send("first");
    await readUntil(it, turnStarted);
    session.steer("a correction");
    let endedCount = 0;
    const events = await readUntil(it, (e) => {
      if (turnEnded(e)) endedCount += 1;
      return endedCount === 2;
    });
    const firstEndIndex = events.findIndex(turnEnded);
    const next = events[firstEndIndex + 1];
    assert.ok(next && turnStarted(next), "turn_started followed turn_ended immediately");
    assert.equal((next as Extract<EngineEvent, { type: "turn_started" }>).cause, "steer");
    await session.close();
  });

  test(`${name}: Stop ends every running Background task`, async () => {
    const session = await harness.makeBackgroundTaskEngine().open(openOptions());
    const it = session.events[Symbol.asyncIterator]();
    session.send("kick off a background task");
    await readUntil(it, (e) => e.type === "task_started");
    session.stop();
    const events = await readUntil(it, turnEnded);
    const settled = events.find((e) => e.type === "task_settled");
    assert.ok(settled, "the Background task was reported settled once Stop landed");
    assert.equal((settled as Extract<EngineEvent, { type: "task_settled" }>).status, "stopped");
    await session.close();
  });

  test(`${name}: a missing Conversation opens fresh and is reported as lost`, async () => {
    const session = await harness.makeSimpleEngine().open(openOptions({ resume: "a-conversation-that-does-not-exist" }));
    const it = session.events[Symbol.asyncIterator]();
    // Some adapters only learn the Conversation id once a Turn actually
    // starts (Claude's is the first `system:init`), so this must drive one
    // rather than assume `conversation` is announced at open() time.
    session.send("hello");
    const events = await readUntil(it, (e) => e.type === "conversation");
    const conversation = events.find((e) => e.type === "conversation") as Extract<
      EngineEvent,
      { type: "conversation" }
    >;
    assert.equal(conversation.resumed, false);
    assert.equal(conversation.lostPrevious, true);
    await session.close();
  });
}
