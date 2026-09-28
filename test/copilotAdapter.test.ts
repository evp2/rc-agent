import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { SessionEvent } from "@github/copilot-sdk";

import { approveEverything, CopilotEngine } from "../src/engine/copilot/adapter.ts";
import type { CopilotRuntime } from "../src/engine/copilot/runtime.ts";
import type { EngineAnswer, EngineEvent, EngineQuestion } from "../src/engine/types.ts";
import {
  event,
  FakeCopilotRuntime,
  type FakeCopilotSession,
  loadFixture,
  simpleTurn,
  splitAt,
  type FakeSessionScript,
} from "./copilotDoubles.ts";
import { runEngineGuaranteeSuite, type EngineGuaranteeHarness } from "./engineGuaranteeSuite.ts";

function engineOn(runtime: CopilotRuntime, model = "auto"): CopilotEngine {
  return new CopilotEngine({ startRuntime: async () => runtime, model });
}

function noQuestionsExpected() {
  return () => new Promise<EngineAnswer>(() => undefined);
}

function openOptions(overrides: { resume?: string } = {}) {
  return { projectDir: "/tmp/copilot-project", onQuestion: noQuestionsExpected(), ...overrides };
}

/** A Turn that runs until the adapter aborts it, then reports the abort the way Copilot does. */
const hangsUntilAborted: FakeSessionScript = {
  onSend: (s) =>
    s.emit([
      event("user.message", { content: "go", delivery: "idle" }),
      event("assistant.turn_start", { turnId: "0" }),
      event("assistant.message", { messageId: "m", content: "working", toolRequests: [] }),
    ]),
  onAbort: (s) =>
    s.emit([event("abort", { reason: "user_initiated" }), event("assistant.idle", { aborted: true })]),
};

const harness: EngineGuaranteeHarness = {
  makeSimpleEngine: () => engineOn(new FakeCopilotRuntime({ onSend: (s) => s.emit(simpleTurn()) })),

  makeErroringEngine: () =>
    engineOn(
      new FakeCopilotRuntime({
        onSend: (s) =>
          s.emit([
            event("user.message", { content: "go", delivery: "idle" }),
            event("assistant.turn_start", { turnId: "0" }),
            event("session.error", { errorType: "model", message: "model call failed" }),
            event("assistant.idle", {}),
          ]),
      }),
    ),

  makeHangingEngine: () => engineOn(new FakeCopilotRuntime(hangsUntilAborted)),

  makeQueueingEngine: () =>
    engineOn(new FakeCopilotRuntime({ onSend: (s, _p, i) => s.emit(simpleTurn(i === 0 ? "first" : "second")) })),

  // The first Command's Turn runs until interrupted; the Steer waits in
  // Copilot's queue, and the interrupt runs it in the Turn's place.
  makeSteerableEngine: () =>
    engineOn(
      new FakeCopilotRuntime({
        onSend: (s, p, i) => i === 0 && hangsUntilAborted.onSend!(s, p, i),
        onInterrupt: (s) => {
          s.emit([
            event("abort", { reason: "user_abort" }),
            event("user.message", { content: "a correction", delivery: "queued" }),
            ...simpleTurn("corrected").slice(1),
          ]);
        },
      }),
    ),

  makeBackgroundTaskEngine: () =>
    engineOn(
      new FakeCopilotRuntime({
        ...hangsUntilAborted,
        onSend: (s) => {
          s.tasks = [
            { id: "bg-1", type: "shell", status: "running", attachmentMode: "detached", description: "dev server" },
          ];
          s.emit([
            event("user.message", { content: "go", delivery: "idle" }),
            event("assistant.turn_start", { turnId: "0" }),
            event("session.background_tasks_changed", {}),
          ]);
        },
      }),
    ),
};

runEngineGuaranteeSuite("CopilotEngine", harness);

const TIMED_OUT = Symbol("timed out");

async function collect(
  iterator: AsyncIterator<EngineEvent>,
  predicate: (e: EngineEvent) => boolean,
  timeoutMs = 2000,
): Promise<EngineEvent[]> {
  const collected: EngineEvent[] = [];
  for (;;) {
    const raced = await Promise.race([
      iterator.next(),
      new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), timeoutMs)),
    ]);
    if (raced === TIMED_OUT) throw new Error(`timed out; collected: ${JSON.stringify(collected)}`);
    if (raced.done) throw new Error(`stream ended; collected: ${JSON.stringify(collected)}`);
    collected.push(raced.value);
    if (predicate(raced.value)) return collected;
  }
}

/** Reads until `count` Turns have ended: a Steered Turn and the Steer's own, say. */
function collectTurns(iterator: AsyncIterator<EngineEvent>, count: number): Promise<EngineEvent[]> {
  let ended = 0;
  return collect(iterator, (e) => e.type === "turn_ended" && ++ended === count);
}

/** Waits for `condition` to hold, failing the test rather than hanging it if it never does. */
async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((r) => setImmediate(r));
  }
}

function only<T extends EngineEvent["type"]>(events: EngineEvent[], type: T): Extract<EngineEvent, { type: T }>[] {
  return events.filter((e) => e.type === type) as Extract<EngineEvent, { type: T }>[];
}

// --- Translation tests: recorded Copilot sessions -> neutral events --------

test("CopilotEngine: a recorded plain Turn reports its text, its model, and token Usage with no dollars", async () => {
  const recording = loadFixture("resume-phase1-generated");
  const runtime = new FakeCopilotRuntime({ onSend: (s) => s.emit(recording) });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("Remember this codeword for later: GENERATED-ZEBRA-42. Reply with just OK.");
  const events = await collect(it, (e) => e.type === "turn_ended");

  assert.deepEqual(only(events, "turn_started"), [{ type: "turn_started", cause: "command" }]);
  assert.deepEqual(only(events, "assistant_text").map((e) => e.text), ["OK"]);
  assert.deepEqual(
    only(events, "announce").map((e) => e.model),
    ["mai-code-1.1-flash"],
    "the model Copilot chose is announced, not the configured `auto`",
  );
  const [ended] = only(events, "turn_ended");
  assert.equal(ended.outcome, "success");
  // Copilot counts cached tokens inside its input count; the neutral one is
  // uncached input only, as on Claude. 9124 - 8704 = 420, which is also what
  // the recording's own session.shutdown totals report.
  assert.deepEqual(ended.usage, { inputTokens: 420, outputTokens: 5, cacheReadTokens: 8704, cacheWriteTokens: 0 });
  assert.equal("costUsd" in ended.usage!, false);
  assert.equal(ended.contextPercentage, 8, "10102 of 128000 tokens");
  await session.close();
});

test("CopilotEngine: a recorded resumed Conversation is announced as resumed, and its Turn remembers", async () => {
  const runtime = new FakeCopilotRuntime({ onSend: (s) => s.emit(loadFixture("resume-phase2-generated")) });
  runtime.known.add("041d5325-81bc-49df-8716-ce43cb96e856");
  const session = await engineOn(runtime).open(openOptions({ resume: "041d5325-81bc-49df-8716-ce43cb96e856" }));
  const it = session.events[Symbol.asyncIterator]();
  session.send("What codeword did I ask you to remember? Reply with just the codeword.");
  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.deepEqual(only(events, "conversation"), [
    { type: "conversation", id: "041d5325-81bc-49df-8716-ce43cb96e856", resumed: true },
  ]);
  assert.deepEqual(only(events, "assistant_text").map((e) => e.text), ["GENERATED-ZEBRA-42"]);
  assert.equal(only(events, "turn_ended")[0].outcome, "success");
  await session.close();
});

test("CopilotEngine: a recorded Turn's tool calls and results stream in order", async () => {
  const [beforeStop] = splitAt(loadFixture("background-abort"), (e) => e.type === "abort");
  const runtime = new FakeCopilotRuntime({ onSend: (s) => s.emit(beforeStop) });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("start a detached sleep, then a foreground one");
  const events = await collect(it, (e) => e.type === "tool_use" && e.toolUseId === "call_427xXbfOgqrkdTLkCgSXSPIt");

  const content = events.filter((e) => e.type === "tool_use" || e.type === "tool_result");
  assert.deepEqual(
    content.map((e) => [e.type, (e as { toolUseId: string }).toolUseId]),
    [
      ["tool_use", "call_s4FY3c7PKu9zllWfFWIa05S3"],
      ["tool_result", "call_s4FY3c7PKu9zllWfFWIa05S3"],
      ["tool_use", "call_427xXbfOgqrkdTLkCgSXSPIt"],
    ],
  );
  const [firstCall] = only(events, "tool_use");
  assert.equal(firstCall.name, "bash");
  assert.match(String((firstCall.input as { command: string }).command), /^sleep 40 && echo finished/);
  const [firstResult] = only(events, "tool_result");
  assert.equal(firstResult.isError, false);
  assert.equal(firstResult.text, "<command started in detached background with shellId: 0>");
  assert.equal(only(events, "turn_started").length, 1, "Copilot's per-model-call turn_start/turn_end don't split the Turn");
  await session.close();
});

test("CopilotEngine: Stop ends the recorded Turn and cancels the detached shell that would survive it", async () => {
  const [beforeStop, afterStop] = splitAt(loadFixture("background-abort"), (e) => e.type === "abort");
  const [stopEvents] = splitAt(afterStop, (e) => e.type === "session.idle");
  const runtime = new FakeCopilotRuntime({
    onSend: (s) => {
      // What Copilot listed at the moment of the Stop: the detached sleep,
      // and the foreground one the Turn was waiting on.
      s.tasks = [
        { id: "0", type: "shell", status: "running", attachmentMode: "detached", executionMode: "background", description: "Start detached background sleep" },
        { id: "1", type: "shell", status: "running", attachmentMode: "attached", executionMode: "sync", description: "Run foreground sleep" },
      ];
      s.emit(beforeStop);
    },
    onAbort: (s) => s.emit(stopEvents),
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("start a detached sleep, then a foreground one");
  // The task list is read after the recorded events, so the task is reported
  // after the second tool call has started.
  const before = await collect(it, (e) => e.type === "task_started");
  assert.ok(before.some((e) => e.type === "tool_use" && e.toolUseId === "call_427xXbfOgqrkdTLkCgSXSPIt"));

  const started = only(before, "task_started");
  assert.deepEqual(
    started.map((e) => e.taskId),
    ["0"],
    "only the detached shell is a Background task; the foreground shell is the Turn's own work",
  );

  session.stop();
  const after = await collect(it, (e) => e.type === "turn_ended");
  assert.equal(only(after, "turn_ended")[0].outcome, "stopped");
  assert.deepEqual(
    only(after, "task_settled").map((e) => [e.taskId, e.status]),
    [["0", "stopped"]],
  );
  // Let the cancellation land.
  await new Promise((r) => setImmediate(r));
  assert.equal(runtime.session.aborts, 1);
  assert.deepEqual(runtime.session.cancelled, ["0"], "the detached shell is cancelled; an abort alone leaves it running");
  await session.close();
});

test("CopilotEngine: a detached shell a Stop killed doesn't wake the agent back into the stopped work", async () => {
  // Copilot reports the killed shell as completed a few seconds later, and
  // the agent goes back to work on its own -- in the recording, re-running
  // the foreground command the human had just stopped.
  const recording = loadFixture("background-abort");
  const [beforeStop, afterStop] = splitAt(recording, (e) => e.type === "abort");
  const [stopEvents] = splitAt(afterStop, (e) => e.type === "session.idle");
  const [, wakeUp] = splitAt(recording, (e) => e.type === "system.notification");
  const runtime = new FakeCopilotRuntime({
    onSend: (s, _p, i) => {
      if (i > 0) return s.emit(simpleTurn("after the stop"));
      s.tasks = [{ id: "0", type: "shell", status: "running", attachmentMode: "detached", description: "sleep" }];
      s.emit(beforeStop);
    },
    onAbort: (s) =>
      s.emit(s.aborts === 1 ? stopEvents : [event("abort", { reason: "user_initiated" }), event("assistant.idle", { aborted: true })]),
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("start a detached sleep, then a foreground one");
  await collect(it, (e) => e.type === "task_started");
  session.stop();
  await collect(it, (e) => e.type === "turn_ended");

  runtime.session.emit(wakeUp);
  while (runtime.session.aborts < 2) await new Promise((r) => setImmediate(r));
  session.send("next");
  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.deepEqual(
    events.filter((e) => e.type === "turn_started" || e.type === "tool_use"),
    [{ type: "turn_started", cause: "command" }],
    "the wake-up is aborted unseen, and the next Command runs after it",
  );
  assert.deepEqual(only(events, "assistant_text").map((e) => e.text), ["after the stop"]);
  assert.equal(runtime.session.aborts, 2);
  await session.close();
});

test("CopilotEngine: a Turn the agent starts with no message of ours is an Engine-started Turn", async () => {
  // The recorded wake-up: the detached shell finished after the Stop, and the
  // agent went back to work on its own.
  const [, wakeUp] = splitAt(loadFixture("background-abort"), (e) => e.type === "system.notification");
  const runtime = new FakeCopilotRuntime();
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  runtime.session.emit(wakeUp);
  const events = await collect(it, (e) => e.type === "tool_use");
  assert.deepEqual(only(events, "turn_started"), [{ type: "turn_started", cause: "engine" }]);
  await session.close();
});

test("CopilotEngine: a Command sent mid-Turn waits in the adapter and goes to Copilot once the Turn ends", async () => {
  let finishFirst: (() => void) | undefined;
  const runtime = new FakeCopilotRuntime({
    onSend: (s, _p, i) => {
      if (i === 0) {
        const [start, rest] = splitAt(simpleTurn("first"), (e) => e.type === "assistant.idle");
        s.emit(start);
        finishFirst = () => s.emit(rest);
      } else {
        s.emit(simpleTurn("second"));
      }
    },
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("first");
  await collect(it, (e) => e.type === "assistant_text");
  session.send("second");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runtime.session.sent, ["first"], "not handed to Copilot while a Turn runs");

  finishFirst!();
  await collect(it, (e) => e.type === "turn_ended");
  const rest = await collect(it, (e) => e.type === "turn_ended");
  assert.deepEqual(only(rest, "assistant_text").map((e) => e.text), ["second"]);
  assert.deepEqual(runtime.session.sent, ["first", "second"]);
  await session.close();
});

test("CopilotEngine: Copilot's own messages and failures mid-Turn end it as an error", async () => {
  const runtime = new FakeCopilotRuntime({
    onSend: (s) =>
      s.emit([
        event("user.message", { content: "go", delivery: "idle" }),
        event("assistant.turn_start", { turnId: "0" }),
        event("session.error", { errorType: "quota", message: "You have exceeded your premium request allowance." }),
        event("assistant.idle", {}),
      ]),
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("go");
  const [ended] = only(await collect(it, (e) => e.type === "turn_ended"), "turn_ended");
  assert.equal(ended.outcome, "error");
  assert.deepEqual(ended.errors, ["You have exceeded your premium request allowance."]);
  await session.close();
});

test("CopilotEngine: the runtime dying mid-Turn ends the Turn as an error, and later Commands fail rather than hang", async () => {
  const runtime = new FakeCopilotRuntime({
    onSend: (s) => s.emit([event("user.message", { content: "go", delivery: "idle" }), event("assistant.turn_start", {})]),
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("go");
  await collect(it, (e) => e.type === "turn_started");
  runtime.session.die();
  const [ended] = only(await collect(it, (e) => e.type === "turn_ended"), "turn_ended");
  assert.equal(ended.outcome, "error");

  session.send("again");
  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.deepEqual(events.map((e) => e.type), ["turn_started", "turn_ended"]);
  assert.equal(only(events, "turn_ended")[0].outcome, "error");
  await session.close();
});

test("CopilotEngine: a send Copilot refuses is reported against that Command", async () => {
  const runtime = new FakeCopilotRuntime({ sendError: new Error("Session not ready") });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("go");
  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.deepEqual(only(events, "turn_started"), [{ type: "turn_started", cause: "command" }]);
  assert.deepEqual(only(events, "turn_ended")[0].errors, ["Session not ready"]);
  await session.close();
});

// --- Steer -------------------------------------------------------------------

const STEP_2 = "call_GVmyNhd7L2AP4PNlcB5uTADb";
const STEER = "Stop the remaining steps. Reply with just the word PINEAPPLE.";

test("CopilotEngine: a recorded Steer lets the running tool call finish, then cuts the Turn there and runs the Steer next", async () => {
  // Five steps, one tool call each; the Steer lands while step 2 runs.
  const recording = loadFixture("steer-D-start");
  const step2Starts = recording.findIndex((e) => e.type === "tool.execution_start" && (e.data as { toolCallId: string }).toolCallId === STEP_2);
  const step2Done = recording.findIndex((e) => e.type === "tool.execution_complete" && (e.data as { toolCallId: string }).toolCallId === STEP_2);
  const runtime = new FakeCopilotRuntime({
    // The Steer itself goes into Copilot's queue, and shows nothing yet.
    onSend: (s, _p, i) => i === 0 && s.emit(recording.slice(0, step2Starts + 1)),
    onInterrupt: (s) => s.emit(recording.slice(step2Done + 1)),
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("Run five steps.");
  await collect(it, (e) => e.type === "tool_use" && e.toolUseId === STEP_2);

  session.steer(STEER);
  await until(() => runtime.session.sent.length === 2);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(runtime.session.sent, ["Run five steps.", STEER], "the Steer is queued with Copilot straight away");
  assert.equal(runtime.session.interrupts, 0, "step 2 is still running, so the Turn isn't cut yet");

  runtime.session.emit(recording.slice(step2Starts + 1, step2Done + 1));
  const events = await collectTurns(it, 2);
  assert.equal(runtime.session.interrupts, 1);
  assert.deepEqual(
    events
      .filter((e) => ["tool_result", "turn_ended", "turn_started", "assistant_text", "tool_use"].includes(e.type))
      .map((e) => (e.type === "turn_ended" ? `${e.type}:${e.outcome}` : e.type === "turn_started" ? `${e.type}:${e.cause}` : e.type === "assistant_text" ? e.text : e.type)),
    ["tool_result", "turn_ended:success", "turn_started:steer", "PINEAPPLE", "turn_ended:success"],
    "step 2 finished, no step 3 ran, and the Steer's Turn followed the cut one directly",
  );
  // Copilot resolves its `auto` model before running the queued Steer; that
  // announcement waits until the Steer's Turn has started.
  const cutAt = events.findIndex((e) => e.type === "turn_ended");
  assert.deepEqual(events[cutAt + 1], { type: "turn_started", cause: "steer" });
  assert.equal(events[cutAt + 2].type, "announce");
  await session.close();
});

test("CopilotEngine: a Steer with no tool call running cuts the Turn at once", async () => {
  const runtime = new FakeCopilotRuntime({
    onSend: (s, p, i) => i === 0 && hangsUntilAborted.onSend!(s, p, i),
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("go");
  await collect(it, (e) => e.type === "assistant_text");
  session.steer("change of plan");
  await until(() => runtime.session.interrupts === 1);
  await session.close();
});

test("CopilotEngine: a Steer that lands as the Turn finishes on its own still runs next, as the Steer's Turn", async () => {
  let finish: (() => void) | undefined;
  const runtime = new FakeCopilotRuntime({
    onSend: (s, _p, i) => {
      if (i > 0) return;
      const [start, rest] = splitAt(simpleTurn("first"), (e) => e.type === "assistant.idle");
      s.emit(start);
      finish = () => s.emit([...rest, event("user.message", { content: "late", delivery: "queued" }), ...simpleTurn("second").slice(1)]);
    },
    // Too late: the Turn had already finished.
    onInterrupt: () => false,
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("go");
  await collect(it, (e) => e.type === "assistant_text");
  finish!();
  session.steer("late");
  const events = await collectTurns(it, 2);
  assert.deepEqual(
    events.filter((e) => e.type === "turn_started" || e.type === "turn_ended").map((e) => (e.type === "turn_started" ? e.cause : e.outcome)),
    ["success", "steer", "success"],
  );
  assert.deepEqual(only(events, "assistant_text").map((e) => e.text), ["second"]);
  await session.close();
});

test("CopilotEngine: Stop while a Steer waits for the running tool call ends the Turn, and the Steer with it", async () => {
  const recording = loadFixture("steer-D-start");
  const step2Starts = recording.findIndex((e) => e.type === "tool.execution_start" && (e.data as { toolCallId: string }).toolCallId === STEP_2);
  const runtime = new FakeCopilotRuntime({
    onSend: (s, _p, i) => i === 0 && s.emit(recording.slice(0, step2Starts + 1)),
    onAbort: (s) =>
      s.emit([event("abort", { reason: "user_initiated" }), event("assistant.idle", { aborted: true })]),
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("Run five steps.");
  await collect(it, (e) => e.type === "tool_use" && e.toolUseId === STEP_2);
  session.steer(STEER);
  await until(() => runtime.session.sent.length === 2);
  session.stop();
  const events = await collectTurns(it, 2);
  assert.deepEqual(
    events.filter((e) => e.type === "turn_started" || e.type === "turn_ended").map((e) => (e.type === "turn_started" ? e.cause : e.outcome)),
    ["stopped", "steer", "stopped"],
    "the Steer is reported as stopped, so whoever sent it hears how it ended",
  );
  // Copilot drops its queue on an abort (measured), so the Steer never runs.
  runtime.session.emit([event("tool.execution_complete", { toolCallId: STEP_2, success: true, result: { content: "step2" } })]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(runtime.session.interrupts, 0, "the finished tool call no longer triggers the cut");
  await session.close();
});

test("CopilotEngine: a Steer is refused with no Turn running, or with one already on its way", async () => {
  const runtime = new FakeCopilotRuntime({ onSend: (s, p, i) => i === 0 && hangsUntilAborted.onSend!(s, p, i) });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  assert.throws(() => session.steer("too early"));
  session.send("go");
  await collect(it, (e) => e.type === "assistant_text");
  session.steer("first");
  assert.throws(() => session.steer("second"));
  await session.close();
});

// --- Questions ---------------------------------------------------------------

const QUESTION = "Which color do you prefer?";

/** The question the recording's `user_input.requested` carried, as the runtime hands it to the handler. */
function recordedRequest(recording: SessionEvent[]) {
  const requested = recording.find((e) => e.type === "user_input.requested")!;
  const { question, choices, allowFreeform } = requested.data as { question: string; choices: string[]; allowFreeform: boolean };
  return { question, choices, allowFreeform };
}

test("CopilotEngine: a recorded question is put to the human as a one-question Question, and the answer resolves the Turn", async () => {
  const recording = loadFixture("question-hold-600s");
  const [asking, answered] = splitAt(recording, (e) => e.type === "user_input.completed");
  let handed: unknown;
  const runtime = new FakeCopilotRuntime({
    onSend: (s) => {
      s.emit(asking);
      // The runtime calls the handler once its question tool runs, and goes
      // on with the Turn only once the handler returns.
      setImmediate(async () => {
        handed = await s.ask(recordedRequest(recording));
        s.emit(answered);
      });
    },
  });
  const asked: { question: EngineQuestion; signal: AbortSignal }[] = [];
  const session = await engineOn(runtime).open({
    projectDir: "/tmp/copilot-project",
    onQuestion: async (question, signal) => {
      asked.push({ question, signal });
      return { answers: { [QUESTION]: "BLUE" } };
    },
  });
  const it = session.events[Symbol.asyncIterator]();
  session.send("Ask me whether I prefer red or blue.");
  const events = await collect(it, (e) => e.type === "turn_ended");

  assert.deepEqual(
    asked.map((a) => a.question),
    [
      {
        toolUseId: "call_sctrYPFttafE6RmzvkQ1codX",
        questions: [{ question: QUESTION, options: [{ label: "RED" }, { label: "BLUE" }], multiSelect: false }],
      },
    ],
    "keyed by the question tool's call, which is what the relay's Question and Answer carry",
  );
  assert.deepEqual(handed, { answer: "BLUE", wasFreeform: false });
  assert.deepEqual(
    events.filter((e) => e.type === "tool_use" || e.type === "tool_result"),
    [],
    "the question tool itself is never shown as a tool call",
  );
  assert.deepEqual(only(events, "assistant_text").map((e) => e.text), ["BLUE"]);
  assert.equal(only(events, "turn_ended")[0].outcome, "success");
  await session.close();
});

test("CopilotEngine: an answer typed instead of picked goes back to Copilot as freeform", async () => {
  const recording = loadFixture("question-hold-600s");
  const [asking] = splitAt(recording, (e) => e.type === "user_input.completed");
  let handed: unknown;
  const runtime = new FakeCopilotRuntime({
    onSend: (s) => {
      s.emit(asking);
      setImmediate(async () => {
        handed = await s.ask(recordedRequest(recording));
      });
    },
  });
  const session = await engineOn(runtime).open({
    projectDir: "/tmp/copilot-project",
    onQuestion: async () => ({ answers: {}, response: "green, actually" }),
  });
  session.send("Ask me whether I prefer red or blue.");
  await until(() => handed !== undefined);
  assert.deepEqual(handed, { answer: "green, actually", wasFreeform: true });
  await session.close();
});

test("CopilotEngine: Stop with a Question pending ends the Turn, withdraws the Question, and nothing stale follows", async () => {
  const recording = loadFixture("question-abort");
  const [asking, afterStop] = splitAt(recording, (e) => e.type === "abort");
  const [stopEvents, nextTurn] = splitAt(afterStop, (e) => e.type === "session.auto_mode_resolved");
  let handlerSettled: string | undefined;
  const runtime = new FakeCopilotRuntime({
    onSend: (s, _p, i) => {
      if (i > 0) return s.emit(nextTurn);
      s.emit(asking);
      setImmediate(() => {
        s.ask(recordedRequest(recording)).then(
          () => (handlerSettled = "answered"),
          () => (handlerSettled = "rejected"),
        );
      });
    },
    onAbort: (s) => s.emit(stopEvents),
  });
  let signal: AbortSignal | undefined;
  const session = await engineOn(runtime).open({
    projectDir: "/tmp/copilot-project",
    onQuestion: (_q, sig) => {
      signal = sig;
      return new Promise<EngineAnswer>((_resolve, reject) => sig.addEventListener("abort", () => reject(new Error("turn stopped"))));
    },
  });
  const it = session.events[Symbol.asyncIterator]();
  session.send("Ask me whether I prefer red or blue.");
  await until(() => signal !== undefined);
  session.stop();
  const stopped = await collect(it, (e) => e.type === "turn_ended");
  assert.equal(only(stopped, "turn_ended")[0].outcome, "stopped");
  assert.equal(signal?.aborted, true, "the pending Question is withdrawn");
  await until(() => handlerSettled !== undefined);
  assert.equal(handlerSettled, "rejected", "Copilot's handler is settled rather than left hanging");

  // The recording ends with the runtime's late completion for the withdrawn
  // question, after the next Turn -- and a straggling result for its tool.
  session.send("Reply with just OK.");
  const next = await collect(it, (e) => e.type === "turn_ended");
  assert.deepEqual(only(next, "assistant_text").map((e) => e.text), ["OK"]);
  runtime.session.emit([
    event("tool.execution_complete", { toolCallId: "call_UkcLnAZZGL9Zdao4nF3OvMyr", success: false, error: { message: "aborted" } }),
  ]);
  const late: EngineEvent[] = [];
  const reading = (async () => {
    for (;;) {
      const n = await it.next();
      if (n.done) return;
      late.push(n.value);
    }
  })();
  await new Promise((r) => setTimeout(r, 20));
  await session.close();
  await reading;
  assert.deepEqual(late, [], "nothing from the withdrawn Question reaches the phone");
});

// --- Menu ----------------------------------------------------------------------

/** What Copilot listed for a project with `.claude/skills/hello` and `.github/skills/ghskill` (CLI 1.0.88), trimmed. */
function recordedMenu(session: FakeCopilotSession): void {
  session.skills = [
    { name: "ghskill", commandName: "ghskill", description: "A skill in .github/skills.", source: "project", userInvocable: true, enabled: true, path: "/p/.github/skills/ghskill/SKILL.md" },
    { name: "hello", commandName: "hello", description: "Says hello back.", source: "project", userInvocable: true, enabled: true, path: "/p/.claude/skills/hello/SKILL.md", argumentHint: "[name]" },
    { name: "mine", commandName: "mine", description: "A personal Copilot skill.", source: "personal-copilot", userInvocable: true, enabled: true, path: "/home/me/.copilot/skills/mine/SKILL.md" },
    { name: "customize-cloud-agent", description: "Built in.", source: "builtin", userInvocable: false, enabled: true },
    { name: "for-claude", description: "Written for Claude.", source: "personal-agents", userInvocable: true, enabled: true, path: join(homedir(), ".claude", "skills", "for-claude", "SKILL.md") },
  ];
  session.commands = [
    { name: "compact", description: "Summarize conversation history", kind: "builtin", input: { hint: "focus instructions" } },
    { name: "usage", description: "Display session usage metrics", kind: "builtin" },
    { name: "context", description: "Show context window token usage", kind: "builtin" },
    { name: "ghskill", description: "A skill in .github/skills.", kind: "skill", input: { hint: "instructions for the skill" } },
    { name: "hello", description: "Says hello back.", kind: "skill", input: { hint: "instructions for the skill" } },
  ];
}

class MenuRuntime extends FakeCopilotRuntime {
  override async createSession(options: Parameters<FakeCopilotRuntime["createSession"]>[0]) {
    const s = await super.createSession(options);
    recordedMenu(s);
    return s;
  }
}

test("CopilotEngine: the menu lists the project's Skills and Copilot's Local commands, split by where they come from", async () => {
  const session = await engineOn(new MenuRuntime()).open(openOptions());
  const [menu] = only(await collect(session.events[Symbol.asyncIterator](), (e) => e.type === "menu"), "menu");
  assert.deepEqual(menu.skills, [
    { name: "ghskill", description: "A skill in .github/skills.", argumentHint: "" },
    { name: "hello", description: "Says hello back.", argumentHint: "[name]" },
    { name: "mine", description: "A personal Copilot skill.", argumentHint: "" },
  ]);
  assert.deepEqual(menu.localCommands, [
    { name: "compact", description: "Summarize conversation history", argumentHint: "focus instructions" },
    { name: "usage", description: "Display session usage metrics", argumentHint: "" },
    { name: "context", description: "Show context window token usage", argumentHint: "" },
  ]);
  assert.ok(!menu.localCommands.some((c) => c.name === "clear"), "Copilot offers SDK clients no /clear");
  await session.close();
});

test("CopilotEngine: the menu refreshes when Copilot's Skills or commands change", async () => {
  const runtime = new MenuRuntime();
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  await collect(it, (e) => e.type === "menu");

  runtime.session.skills.push({ name: "fresh", description: "Just added.", source: "project", userInvocable: true, enabled: true });
  runtime.session.emit([event("session.skills_loaded", { skills: [] })]);
  const [refreshed] = only(await collect(it, (e) => e.type === "menu"), "menu");
  assert.ok(refreshed.skills.some((k) => k.name === "fresh"));

  runtime.session.commands.push({ name: "review", description: "Review changes", kind: "builtin" });
  runtime.session.emit([event("commands.changed", {})]);
  const [again] = only(await collect(it, (e) => e.type === "menu"), "menu");
  assert.ok(again.localCommands.some((c) => c.name === "review"));
  await session.close();
});

// --- Local commands and compaction ---------------------------------------------

/** A MenuRuntime whose slash commands answer as `onInvoke` says. */
function commandRuntime(script: FakeSessionScript): MenuRuntime {
  return new MenuRuntime(script);
}

test("CopilotEngine: /compact runs through Copilot's command call, as an ordinary Turn with no overflow notice", async () => {
  // What `/compact` did on CLI 1.0.88: compaction events while the call ran,
  // a fresh context reading, then a line of text as the call's result.
  const runtime = commandRuntime({
    onInvoke: async (s) => {
      s.emit([
        event("session.compaction_start", { trigger: "manual", currentTokens: 10155 }),
        event("session.compaction_complete", { success: true, preCompactionTokens: 4300, postCompactionTokens: 306 }),
        event("session.usage_info", { tokenLimit: 128000, currentTokens: 10418 }),
      ]);
      await new Promise((r) => setTimeout(r, 5));
      return { kind: "text", text: "Compacted conversation history and removed 1 message and 3,994 tokens." };
    },
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  await collect(it, (e) => e.type === "menu");
  session.send("/compact");
  const events = await collect(it, (e) => e.type === "turn_ended");

  assert.deepEqual(runtime.session.invoked, [{ name: "compact" }]);
  assert.deepEqual(runtime.session.sent, [], "never sent to the model as a prompt");
  assert.deepEqual(
    events.map((e) => e.type),
    ["turn_started", "compacting", "compacted", "turn_ended"],
    "one Turn, whose compaction already says what the command's own text would",
  );
  assert.deepEqual(only(events, "compacting"), [{ type: "compacting", trigger: "manual" }]);
  assert.deepEqual(only(events, "compacted")[0], { type: "compacted", preTokens: 4300, postTokens: 306 });
  const [ended] = only(events, "turn_ended");
  assert.equal(ended.outcome, "success");
  assert.equal(ended.contextPercentage, 8, "10418 of 128000 tokens, read after the compaction");
  await session.close();
});

test("CopilotEngine: a Local command's text output becomes a status line", async () => {
  const usage = "Session Usage\n\nChanges: +0 -0\nRequests: 1 AI Units (6s)\nTokens: input 9.2k, output 5, cached 1.2k";
  const runtime = commandRuntime({ onInvoke: async () => ({ kind: "text", text: usage }) });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("/usage");
  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.deepEqual(events.filter((e) => e.type !== "conversation" && e.type !== "menu"), [
    { type: "turn_started", cause: "command" },
    { type: "status", text: usage },
    events.at(-1),
  ]);
  assert.equal(only(events, "turn_ended")[0].outcome, "success");
  await session.close();
});

test("CopilotEngine: a Skill's command hands the agent its prompt, all in the one Turn", async () => {
  const runtime = commandRuntime({
    onInvoke: async () => ({ kind: "agent-prompt", prompt: "The user explicitly invoked the /hello skill.", displayPrompt: "/hello" }),
    onSend: (s) => s.emit(simpleTurn("HELLO-SKILL-RAN Bob")),
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("/hello Bob");
  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.deepEqual(runtime.session.invoked, [{ name: "hello", input: "Bob" }]);
  assert.deepEqual(runtime.session.sent, ["The user explicitly invoked the /hello skill."]);
  assert.deepEqual(only(events, "turn_started"), [{ type: "turn_started", cause: "command" }]);
  assert.deepEqual(only(events, "assistant_text").map((e) => e.text), ["HELLO-SKILL-RAN Bob"]);
  assert.equal(only(events, "turn_ended")[0].outcome, "success");
  await session.close();
});

test("CopilotEngine: a Local command Copilot refuses ends its Turn with Copilot's message", async () => {
  const runtime = commandRuntime({
    onInvoke: async () => {
      throw new Error("Request session.commands.invoke failed with message: Usage: /compact [focus instructions]");
    },
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("/compact now please");
  const [ended] = only(await collect(it, (e) => e.type === "turn_ended"), "turn_ended");
  assert.equal(ended.outcome, "error");
  assert.deepEqual(ended.errors, ["Usage: /compact [focus instructions]"]);
  await session.close();
});

test("CopilotEngine: a Local command that wants a choice made says what the choices are", async () => {
  const runtime = commandRuntime({
    onInvoke: async () => ({
      kind: "select-subcommand",
      command: "usage",
      title: "Usage",
      options: [{ name: "today" }, { name: "week" }],
    }),
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("/usage");
  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.deepEqual(only(events, "status").map((e) => e.text), ["Usage: /usage today, /usage week"]);
  await session.close();
});

test("CopilotEngine: text that merely starts with a slash is a prompt, not a Local command", async () => {
  const runtime = commandRuntime({ onSend: (s) => s.emit(simpleTurn()) });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("/tmp/build.log shows a failure -- why?");
  await collect(it, (e) => e.type === "turn_ended");
  assert.deepEqual(runtime.session.invoked, []);
  assert.deepEqual(runtime.session.sent, ["/tmp/build.log shows a failure -- why?"]);
  await session.close();
});

test("CopilotEngine: a Local command can't be Steered in; it waits for the Turn to end", async () => {
  const runtime = commandRuntime({
    onSend: (s, p, i) => i === 0 && hangsUntilAborted.onSend!(s, p, i),
    onInvoke: async () => ({ kind: "text", text: "done" }),
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("go");
  await collect(it, (e) => e.type === "assistant_text");
  assert.throws(() => session.steer("/compact"));
  await session.close();
});

test("CopilotEngine: Stop during a Local command ends its Turn, and its late result is dropped", async () => {
  let finish: ((r: { kind: "text"; text: string }) => void) | undefined;
  const runtime = commandRuntime({
    onInvoke: () => new Promise((resolve) => (finish = resolve)),
    onAbort: (s) => s.emit([event("abort", { reason: "user_initiated" })]),
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("/compact");
  await collect(it, (e) => e.type === "turn_started");
  session.stop();
  const [ended] = only(await collect(it, (e) => e.type === "turn_ended"), "turn_ended");
  assert.equal(ended.outcome, "stopped");
  finish!({ kind: "text", text: "Compacted." });
  const late: EngineEvent[] = [];
  const reading = (async () => {
    for (;;) {
      const n = await it.next();
      if (n.done) return;
      late.push(n.value);
    }
  })();
  await new Promise((r) => setTimeout(r, 20));
  await session.close();
  await reading;
  assert.deepEqual(late, []);
});

test("CopilotEngine: Stop just as a Skill's prompt is handed over stops that prompt's Turn once it starts", async () => {
  let startPrompt: (() => void) | undefined;
  let started = false;
  const runtime = commandRuntime({
    onInvoke: async () => ({ kind: "agent-prompt", prompt: "Run the hello skill." }),
    onSend: (s) => {
      startPrompt = () => {
        started = true;
        s.emit([event("user.message", { content: "Run the hello skill.", delivery: "idle" })]);
      };
    },
    // An abort before the prompt's Turn has started has nothing to abort.
    onAbort: (s) => started && s.emit([event("abort", { reason: "user_initiated" }), event("assistant.idle", { aborted: true })]),
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("/hello");
  await until(() => runtime.session.sent.length === 1);
  session.stop();
  startPrompt!();
  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.deepEqual(only(events, "turn_started"), [{ type: "turn_started", cause: "command" }]);
  assert.equal(only(events, "turn_ended")[0].outcome, "stopped");
  assert.equal(runtime.session.aborts, 1);
  await session.close();
});

test("CopilotEngine: Copilot compacting on its own is reported as automatic, which the phone shows as an overflow", async () => {
  const runtime = new FakeCopilotRuntime({
    onSend: (s) => {
      const [start, rest] = splitAt(simpleTurn(), (e) => e.type === "assistant.idle");
      s.emit([
        ...start,
        event("session.compaction_start", { trigger: "threshold" }),
        event("session.compaction_complete", { success: true, preCompactionTokens: 100000, postCompactionTokens: 20000 }),
        ...rest,
      ]);
    },
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("go");
  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.deepEqual(only(events, "compacting"), [{ type: "compacting", trigger: "auto" }]);
  assert.deepEqual(only(events, "compacted"), [{ type: "compacted", preTokens: 100000, postTokens: 20000 }]);
  await session.close();
});

// --- Opening a session ------------------------------------------------------

test("CopilotEngine: a fresh session announces its Conversation straight away, and runs in the project directory on the configured model", async () => {
  const runtime = new FakeCopilotRuntime();
  const session = await engineOn(runtime, "gpt-5.6-luna").open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  const [conversation] = await collect(it, (e) => e.type === "conversation");
  assert.deepEqual(conversation, { type: "conversation", id: "copilot-1", resumed: false });
  assert.equal(runtime.session.options.workingDirectory, "/tmp/copilot-project");
  assert.equal(runtime.session.options.model, "gpt-5.6-luna");
  await session.close();
});

test("CopilotEngine: resume reopens the named Conversation", async () => {
  const runtime = new FakeCopilotRuntime();
  runtime.known.add("conv-1");
  const session = await engineOn(runtime).open(openOptions({ resume: "conv-1" }));
  const [conversation] = await collect(session.events[Symbol.asyncIterator](), (e) => e.type === "conversation");
  assert.deepEqual(conversation, { type: "conversation", id: "conv-1", resumed: true });
  await session.close();
});

test("CopilotEngine: a Conversation Copilot no longer has opens fresh and says it was lost", async () => {
  const runtime = new FakeCopilotRuntime();
  const session = await engineOn(runtime).open(openOptions({ resume: "gone" }));
  const [conversation] = await collect(session.events[Symbol.asyncIterator](), (e) => e.type === "conversation");
  assert.deepEqual(conversation, { type: "conversation", id: "copilot-1", resumed: false, lostPrevious: true });
  await session.close();
});

test("CopilotEngine: opening fails with Copilot's own message when it refuses a session outright", async () => {
  const runtime = new FakeCopilotRuntime();
  runtime.createError = new Error("Copilot CLI is disabled by your organization's policy.");
  await assert.rejects(engineOn(runtime).open(openOptions({ resume: "gone" })), /disabled by your organization's policy/);
  assert.equal(runtime.stopped, true, "no runtime process is left behind");
});

test("CopilotEngine: verify() fails with Copilot's own message when nobody is signed in", async () => {
  const runtime = new FakeCopilotRuntime();
  runtime.auth = { isAuthenticated: false, statusMessage: "Not logged in. Run `copilot login`." };
  await assert.rejects(engineOn(runtime).verify(), /Not logged in\. Run `copilot login`\./);
  assert.equal(runtime.stopped, true, "no runtime process is left behind");
});

test("CopilotEngine: verify() passes when signed in, and the session reuses the runtime it started", async () => {
  let starts = 0;
  const runtime = new FakeCopilotRuntime();
  const engine = new CopilotEngine({ startRuntime: async () => (starts++, runtime), model: "auto" });
  await engine.verify();
  const session = await engine.open(openOptions());
  assert.equal(starts, 1);
  await session.close();
  assert.equal(runtime.session.disconnected, true);
  assert.equal(runtime.stopped, true, "closing the session stops the runtime process too");
});

test("CopilotEngine: Fork is refused, since Copilot can't carry a Conversation into a new worktree yet", async () => {
  await assert.rejects(
    engineOn(new FakeCopilotRuntime()).forkConversation({ conversationId: "c", fromDir: "/a", toDir: "/b" }),
    /isn't available for Copilot/,
  );
});

test("CopilotEngine: reports it can't Fork, so a Fork is refused before any worktree is made", () => {
  assert.equal(engineOn(new FakeCopilotRuntime()).capabilities.fork, false);
});

test("CopilotEngine: reports it can Steer", () => {
  assert.equal(engineOn(new FakeCopilotRuntime()).capabilities.steer, true);
});

// --- Permissions ------------------------------------------------------------

test("approveEverything approves a request, even under managed settings, where the SDK's approveAll throws", async () => {
  const request = { kind: "shell" } as Parameters<typeof approveEverything>[0];
  assert.deepEqual(await approveEverything(request, { sessionId: "s", managedSettingsEnabled: true }), {
    kind: "approve-once",
  });
});

test("approveEverything leaves a request managed settings must approve to the policy", async () => {
  const request = { kind: "shell", managedApprovalRequired: true } as unknown as Parameters<typeof approveEverything>[0];
  assert.deepEqual(await approveEverything(request, { sessionId: "s", managedSettingsEnabled: true }), {
    kind: "no-result",
  });
});
