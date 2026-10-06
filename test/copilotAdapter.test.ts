import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { SessionEvent } from "@github/copilot-sdk";

import { approveEverything, CopilotEngine } from "../src/engine/copilot/adapter.ts";
import type { CopilotRuntime } from "../src/engine/copilot/runtime.ts";
import type {
  EngineAnswer,
  EngineEvent,
  EngineImage,
  EngineQuestion,
  ShowImageOutcome,
} from "../src/engine/types.ts";
import {
  event,
  FakeCopilotRuntime,
  type FakeCopilotSession,
  loadFixture,
  simpleTurn,
  splitAt,
  type FakeSessionScript,
} from "./copilotDoubles.ts";
import {
  runEngineGuaranteeSuite,
  SHOW_IMAGE_CALL,
  type EngineGuaranteeHarness,
  type ShowImageToolResult,
} from "./engineGuaranteeSuite.ts";

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

  // Copilot starts the call, the SDK runs the registered handler, and only
  // once it has replied does the call complete and the Turn go on.
  makeShowImageEngine: () => {
    let seen: ShowImageToolResult | undefined;
    const { toolUseId, path, caption } = SHOW_IMAGE_CALL;
    const engine = engineOn(
      new FakeCopilotRuntime({
        onSend: async (s) => {
          s.emit([
            event("user.message", { content: "show me", delivery: "idle" }),
            event("assistant.turn_start", { turnId: "0" }),
            event("tool.execution_start", {
              toolCallId: toolUseId,
              toolName: "show_image",
              arguments: { path, caption },
            }),
          ]);
          const reply = await s.callTool("show_image", { path, caption }, toolUseId);
          seen =
            "error" in reply
              ? { text: reply.error, isError: true }
              : typeof reply.result === "string"
                ? { text: reply.result, isError: false }
                : { text: reply.result.textResultForLlm, isError: reply.result.resultType !== "success" };
          s.emit([
            event("tool.execution_complete", {
              toolCallId: toolUseId,
              success: !seen.isError,
              result: { content: seen.text },
            }),
            ...simpleTurn("there it is").slice(2),
          ]);
        },
      }),
    );
    return { engine, toolResult: () => seen };
  },
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

// --- Background tasks --------------------------------------------------------

const DETACHED_CALL = "call_NdeTKQ2OBEAmaem5iVTHMfmR";
const DETACHED_COMMAND = "sleep 8 && echo finished > done.txt";

/** What Copilot listed while the recorded Turn ran: the detached shell, and the foreground echo beside it. */
function recordedTasks() {
  return [
    { id: "0", type: "shell", status: "running" as const, attachmentMode: "detached" as const, executionMode: "background" as const, description: "Start detached delayed marker", command: DETACHED_COMMAND, pid: 1 },
    { id: "1", type: "shell", status: "running" as const, attachmentMode: "attached" as const, executionMode: "sync" as const, description: "Run foreground echo", command: "echo fg", pid: 2 },
  ];
}

/**
 * A recorded Turn that starts a detached shell and a foreground one, and the
 * wake-up the shell's completion caused once that Turn had ended.
 */
function backgroundComplete() {
  const recording = loadFixture("background-complete");
  const firstIdle = recording.findIndex((e) => e.type === "session.idle");
  const turn = recording.slice(0, firstIdle + 1);
  const wakeUp = recording.slice(firstIdle + 1).filter((e) => e.type !== "session.background_tasks_changed");
  return { turn, wakeUp };
}

test("CopilotEngine: a recorded detached shell is a Background task anchored to the tool call that started it", async () => {
  const { turn } = backgroundComplete();
  const runtime = new FakeCopilotRuntime({
    onSend: (s) => {
      s.tasks = recordedTasks();
      s.emit(turn);
    },
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("start a detached shell and a foreground one");
  // The list is read once the recorded events have all been delivered.
  const events = await collect(it, (e) => e.type === "tasks_changed");

  assert.deepEqual(only(events, "task_started"), [
    {
      type: "task_started",
      taskId: "0",
      toolUseId: DETACHED_CALL,
      description: "Start detached delayed marker",
      taskType: "shell",
      ambient: false,
    },
  ]);
  assert.deepEqual(only(events, "tasks_changed").at(-1)!.tasks.map((t) => t.taskId), ["0"], "the foreground shell never reaches the tray");
  await session.close();
});

test("CopilotEngine: a detached shell finishing on its own settles as completed, then wakes the agent into an Engine-started Turn", async () => {
  const { turn, wakeUp } = backgroundComplete();
  const runtime = new FakeCopilotRuntime({
    onSend: (s) => {
      s.tasks = recordedTasks();
      s.emit(turn);
    },
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("start a detached shell and a foreground one");
  await collect(it, (e) => e.type === "turn_ended");

  // Copilot's list can lag its notification; the notification alone settles the shell.
  runtime.session.emit(wakeUp);
  const events = await collect(it, (e) => e.type === "turn_ended");
  const kinds = events.map((e) => e.type).filter((t) => t === "task_settled" || t === "turn_started" || t === "turn_ended");
  assert.deepEqual(kinds, ["task_settled", "turn_started", "turn_ended"], "settled before the Turn it causes starts");
  assert.deepEqual(only(events, "task_settled"), [
    { type: "task_settled", taskId: "0", toolUseId: DETACHED_CALL, status: "completed", ambient: false },
  ]);
  assert.deepEqual(only(events, "tasks_changed").at(-1), { type: "tasks_changed", tasks: [] });
  assert.deepEqual(only(events, "turn_started"), [{ type: "turn_started", cause: "engine" }]);
  assert.deepEqual(only(events, "assistant_text").map((e) => e.text), ["Done."]);
  assert.equal(only(events, "turn_ended")[0].outcome, "success");
  assert.equal(runtime.session.aborts, 0, "a shell that finished on its own wakes the agent for real");
  await session.close();
});

test("CopilotEngine: Kill ends one detached shell mid-Turn; its card shows stopped and the Turn keeps running", async () => {
  const runtime = new FakeCopilotRuntime({
    ...hangsUntilAborted,
    onSend: (s, p, i) => {
      s.tasks = [
        { id: "bg-1", type: "shell", status: "running", attachmentMode: "detached", description: "dev server" },
        { id: "bg-2", type: "shell", status: "running", attachmentMode: "detached", description: "watcher" },
      ];
      hangsUntilAborted.onSend!(s, p, i);
      s.emit([event("session.background_tasks_changed", {})]);
    },
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("start two background shells");
  await collect(it, (e) => e.type === "tasks_changed");

  await session.killTask("bg-1");
  const events = await collect(it, (e) => e.type === "tasks_changed");
  assert.deepEqual(only(events, "task_settled").map((e) => [e.taskId, e.status]), [["bg-1", "stopped"]]);
  assert.deepEqual(only(events, "tasks_changed")[0].tasks.map((t) => t.taskId), ["bg-2"]);
  assert.equal(only(events, "turn_ended").length, 0, "the Turn keeps running");
  assert.deepEqual(runtime.session.cancelled, ["bg-1"]);
  assert.equal(runtime.session.aborts, 0);

  await session.killTask("bg-1");
  await session.killTask("no-such-task");
  session.stop();
  const rest = await collect(it, (e) => e.type === "turn_ended");
  assert.deepEqual(
    only(rest, "task_settled").map((e) => [e.taskId, e.status]),
    [["bg-2", "stopped"]],
    "a second Kill, or one for an unknown task, reports nothing",
  );
  await session.close();
});

test("CopilotEngine: a detached shell Kill ended between Turns doesn't wake the agent back up", async () => {
  // The runtime ends a detached shell it can't cancel by signalling it, and
  // then reports it completed, which would wake the agent.
  const { turn, wakeUp } = backgroundComplete();
  const runtime = new FakeCopilotRuntime({
    onSend: (s, _p, i) => {
      if (i > 0) return s.emit(simpleTurn("after the kill"));
      s.tasks = recordedTasks();
      s.emit(turn);
    },
    onAbort: (s) => s.emit([event("abort", { reason: "user_initiated" }), event("assistant.idle", { aborted: true })]),
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("start a detached shell and a foreground one");
  await collect(it, (e) => e.type === "turn_ended");

  await session.killTask("0");
  await collect(it, (e) => e.type === "task_settled");
  runtime.session.emit(wakeUp);
  await until(() => runtime.session.aborts === 1);
  session.send("next");
  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.deepEqual(
    events.filter((e) => e.type === "turn_started" || e.type === "tool_use" || e.type === "task_settled"),
    [{ type: "turn_started", cause: "command" }],
    "the wake-up is aborted unseen, and the shell isn't settled twice",
  );
  assert.deepEqual(only(events, "assistant_text").map((e) => e.text), ["after the kill"]);
  await session.close();
});

test("CopilotEngine: a Background task that drops out of Copilot's list settles rather than spinning forever", async () => {
  const runtime = new FakeCopilotRuntime();
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  runtime.session.tasks = [{ id: "bg-1", type: "shell", status: "running", attachmentMode: "detached", description: "dev server" }];
  runtime.session.emit([event("session.background_tasks_changed", {})]);
  await collect(it, (e) => e.type === "tasks_changed");

  runtime.session.tasks = [];
  runtime.session.emit([event("session.background_tasks_changed", {})]);
  const events = await collect(it, (e) => e.type === "tasks_changed");
  assert.deepEqual(only(events, "task_settled").map((e) => [e.taskId, e.status]), [["bg-1", "completed"]]);
  assert.deepEqual(only(events, "tasks_changed")[0].tasks, []);
  await session.close();
});

test("CopilotEngine: a background agent settles with the status Copilot's completion notice gives it", async () => {
  const runtime = new FakeCopilotRuntime();
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  runtime.session.tasks = [
    { id: "agent-1", type: "agent", status: "running", executionMode: "background", toolCallId: "call-agent", description: "explore the repo" },
    { id: "agent-2", type: "agent", status: "running", executionMode: "sync", toolCallId: "call-sync", description: "the Turn's own" },
  ];
  runtime.session.emit([event("session.background_tasks_changed", {})]);
  const started = await collect(it, (e) => e.type === "tasks_changed");
  assert.deepEqual(only(started, "task_started").map((e) => [e.taskId, e.toolUseId]), [["agent-1", "call-agent"]]);

  runtime.session.emit([
    event("system.notification", { content: "", kind: { type: "agent_completed", agentId: "agent-1", agentType: "explore", status: "failed" } }),
  ]);
  const settled = await collect(it, (e) => e.type === "tasks_changed");
  assert.deepEqual(only(settled, "task_settled").map((e) => [e.taskId, e.toolUseId, e.status]), [["agent-1", "call-agent", "failed"]]);
  await session.close();
});

test("CopilotEngine: a background agent Copilot lists as idle has finished, and settles as completed", async () => {
  // Copilot keeps a finished agent listed as idle, open to follow-up
  // messages, and never goes on to list it completed (measured on CLI 1.0.88).
  const runtime = new FakeCopilotRuntime();
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  const agent = { id: "agent-1", type: "agent", executionMode: "background", toolCallId: "call-agent", description: "say hello" } as const;
  runtime.session.tasks = [{ ...agent, status: "running" }];
  runtime.session.emit([event("session.background_tasks_changed", {})]);
  await collect(it, (e) => e.type === "tasks_changed");

  runtime.session.tasks = [{ ...agent, status: "idle" }];
  runtime.session.emit([event("session.background_tasks_changed", {})]);
  const events = await collect(it, (e) => e.type === "tasks_changed");
  assert.deepEqual(only(events, "task_settled").map((e) => [e.taskId, e.toolUseId, e.status]), [["agent-1", "call-agent", "completed"]]);
  assert.deepEqual(only(events, "tasks_changed")[0].tasks, []);
  await session.close();
});

test("CopilotEngine: a finished background agent a follow-up message wakes is running again, then settles again", async () => {
  // Copilot's write_agent takes an idle agent back to running, under the same
  // id, and it goes idle again once it has answered (measured on CLI 1.0.88).
  const runtime = new FakeCopilotRuntime();
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  const agent = { id: "agent-1", type: "agent", executionMode: "background", toolCallId: "call-agent", description: "say hello" } as const;
  for (const status of ["running", "idle"] as const) {
    runtime.session.tasks = [{ ...agent, status }];
    runtime.session.emit([event("session.background_tasks_changed", {})]);
    await collect(it, (e) => e.type === "tasks_changed");
  }

  runtime.session.tasks = [{ ...agent, status: "running" }];
  runtime.session.emit([event("session.background_tasks_changed", {})]);
  const revived = await collect(it, (e) => e.type === "tasks_changed");
  assert.deepEqual(only(revived, "task_started").map((e) => [e.taskId, e.toolUseId]), [["agent-1", "call-agent"]]);
  assert.deepEqual(only(revived, "tasks_changed")[0].tasks.map((t) => t.taskId), ["agent-1"]);

  runtime.session.tasks = [{ ...agent, status: "idle" }];
  runtime.session.emit([event("session.background_tasks_changed", {})]);
  const settled = await collect(it, (e) => e.type === "tasks_changed");
  assert.deepEqual(only(settled, "task_settled").map((e) => [e.taskId, e.status]), [["agent-1", "completed"]]);
  assert.deepEqual(only(settled, "tasks_changed")[0].tasks, []);
  await session.close();
});

test("CopilotEngine: a schedule Copilot creates is a Background task, named for the prompt it fires", async () => {
  // Measured on CLI 1.0.88: `/every` and `/after`, and the agent's own
  // manage_schedule, each announce the schedule they register.
  const runtime = new FakeCopilotRuntime();
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  runtime.session.emit([
    event("session.schedule_created", { id: 1, intervalMs: 60000, prompt: "probe the host", recurring: true, origin: "user" }),
  ]);
  const events = await collect(it, (e) => e.type === "tasks_changed");
  assert.deepEqual(
    only(events, "task_started").map((e) => [e.taskId, e.taskType, e.description, e.toolUseId]),
    [["schedule-1", "schedule", "probe the host", undefined]],
  );
  assert.deepEqual(only(events, "tasks_changed")[0].tasks.map((t) => t.taskId), ["schedule-1"]);
  await session.close();
});

test("CopilotEngine: Kill on a schedule removes it from Copilot, so it fires no more, and its card shows stopped", async () => {
  const runtime = new FakeCopilotRuntime();
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  runtime.session.emit([
    event("session.schedule_created", { id: 1, intervalMs: 60000, prompt: "probe the host", recurring: true, origin: "user" }),
    event("session.schedule_created", { id: 2, intervalMs: 60000, prompt: "check the deploy", recurring: true, origin: "user" }),
  ]);
  await collect(it, (e) => e.type === "tasks_changed" && e.tasks.length === 2);

  await session.killTask("schedule-1");
  const events = await collect(it, (e) => e.type === "tasks_changed");
  assert.deepEqual(runtime.session.schedulesStopped, [1]);
  assert.deepEqual(runtime.session.cancelled, [], "a schedule isn't one of Copilot's tasks");
  assert.deepEqual(only(events, "task_settled").map((e) => [e.taskId, e.status]), [["schedule-1", "stopped"]]);
  assert.deepEqual(only(events, "tasks_changed")[0].tasks.map((t) => t.taskId), ["schedule-2"]);
  await session.close();
});

test("CopilotEngine: a one-shot schedule that has fired settles as completed", async () => {
  // Measured on CLI 1.0.88: an `/after` schedule is cancelled once it fires.
  const runtime = new FakeCopilotRuntime();
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  runtime.session.emit([
    event("session.schedule_created", { id: 2, intervalMs: 10000, prompt: "check once", recurring: false, origin: "user" }),
  ]);
  await collect(it, (e) => e.type === "tasks_changed");

  runtime.session.emit([
    event("user.message", { content: "[Scheduled prompt #2]\ncheck once", source: "schedule-2", delivery: "idle" }),
    event("assistant.idle", {}),
    event("session.schedule_cancelled", { id: 2 }),
  ]);
  const events = await collect(it, (e) => e.type === "tasks_changed");
  assert.deepEqual(only(events, "task_settled").map((e) => [e.taskId, e.status]), [["schedule-2", "completed"]]);
  assert.deepEqual(only(events, "tasks_changed")[0].tasks, []);
  await session.close();
});

test("CopilotEngine: Stop removes every schedule from Copilot, as it ends every other Background task", async () => {
  const runtime = new FakeCopilotRuntime();
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  runtime.session.schedules = [1];
  runtime.session.emit([
    event("session.schedule_created", { id: 1, intervalMs: 60000, prompt: "probe the host", recurring: true, origin: "user" }),
  ]);
  await collect(it, (e) => e.type === "tasks_changed");

  session.stop();
  const events = await collect(it, (e) => e.type === "tasks_changed");
  assert.deepEqual(only(events, "task_settled").map((e) => [e.taskId, e.status]), [["schedule-1", "stopped"]]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runtime.session.schedulesStopped, [1]);
  await session.close();
});

test("CopilotEngine: closing removes every schedule from Copilot, even one registered before the connector opened", async () => {
  // Copilot keeps schedules across a resume; left in place, one would go on
  // firing after the restart had reported it interrupted.
  const runtime = new FakeCopilotRuntime();
  const session = await engineOn(runtime).open(openOptions());
  runtime.session.schedules = [3];
  await session.close();
  assert.deepEqual(runtime.session.schedulesStopped, [3]);
});

test("CopilotEngine: closing ends the Background tasks still running, and reports none of them settled", async () => {
  // They would outlive the connector; left unsettled, the next start reports
  // them interrupted by the restart.
  const runtime = new FakeCopilotRuntime();
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  runtime.session.tasks = [
    { id: "bg-1", type: "shell", status: "running", attachmentMode: "detached", description: "dev server" },
    { id: "fg-1", type: "shell", status: "running", attachmentMode: "attached", description: "foreground" },
  ];
  runtime.session.emit([event("session.background_tasks_changed", {})]);
  await collect(it, (e) => e.type === "tasks_changed");

  await session.close();
  assert.deepEqual(runtime.session.cancelled, ["bg-1"]);
  const rest: EngineEvent[] = [];
  for (let next = await it.next(); !next.done; next = await it.next()) rest.push(next.value);
  assert.deepEqual(only(rest, "task_settled"), []);
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
      if (i === 0) {
        const [start, rest] = splitAt(simpleTurn("first"), (e) => e.type === "assistant.idle");
        s.emit(start);
        finish = () => s.emit(rest);
        return;
      }
      // Copilot had gone idle by the time the Steer reached it, so it runs
      // straight away, and Copilot's reply comes after the idle.
      s.emit([event("user.message", { content: "late", delivery: "idle" }), ...simpleTurn("second").slice(1)]);
      return new Promise((r) => setImmediate(r));
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
  assert.deepEqual(runtime.session.sent, ["go", "late"], "the Steer is handed over once, not again after the idle");
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

/**
 * A first Command whose Turn runs until something ends it; `endTurn` says
 * how. Every later prompt runs as a plain Turn that answers with its own text.
 */
function droppedSteerRuntime(onInterrupt: FakeSessionScript["onInterrupt"]) {
  return new FakeCopilotRuntime({
    onSend: (s, p, i) => {
      if (i === 0) return hangsUntilAborted.onSend!(s, p, i);
      // The Steer's first send only queues it behind the running Turn.
      if (p === "change of plan" && s.sent.filter((x) => x === p).length === 1) return;
      s.emit([event("user.message", { content: p, delivery: "idle" }), ...simpleTurn(p).slice(1)]);
    },
    onInterrupt,
  });
}

test("CopilotEngine: a Steer Copilot drops from its queue runs as the Steer's own Turn, and later Commands still run", async () => {
  // Copilot runs a queued prompt straight after the Turn ends, with no idle
  // in between (measured); an idle with the Steer still queued means Copilot
  // dropped it.
  const runtime = droppedSteerRuntime((s) => {
    s.emit([event("abort", { reason: "user_abort" }), event("assistant.idle", { aborted: true })]);
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("go");
  await collect(it, (e) => e.type === "assistant_text");
  session.steer("change of plan");
  await until(() => runtime.session.interrupts === 1);
  session.send("next");
  const events = await collectTurns(it, 3);
  assert.deepEqual(
    events.filter((e) => e.type === "turn_started" || e.type === "turn_ended").map((e) => (e.type === "turn_started" ? e.cause : e.outcome)),
    ["success", "steer", "success", "command", "success"],
  );
  assert.deepEqual(only(events, "assistant_text").map((e) => e.text), ["change of plan", "next"]);
  assert.deepEqual(runtime.session.sent, ["go", "change of plan", "change of plan", "next"]);
  await session.close();
});

test("CopilotEngine: a Steer Copilot drops twice is reported as never run, and later Commands still run", async () => {
  const runtime = new FakeCopilotRuntime({
    onSend: (s, p, i) => {
      if (i === 0) return hangsUntilAborted.onSend!(s, p, i);
      if (p === "change of plan") {
        // Queued the first time; dropped again straight away the second.
        if (s.sent.length > 2) s.emit([event("assistant.idle", {})]);
        return;
      }
      s.emit([event("user.message", { content: p, delivery: "idle" }), ...simpleTurn(p).slice(1)]);
    },
    onInterrupt: (s) => {
      s.emit([event("abort", { reason: "user_abort" }), event("assistant.idle", { aborted: true })]);
    },
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("go");
  await collect(it, (e) => e.type === "assistant_text");
  session.steer("change of plan");
  await until(() => runtime.session.interrupts === 1);
  session.send("next");
  const events = await collectTurns(it, 3);
  assert.deepEqual(
    events.filter((e) => e.type === "turn_started" || e.type === "turn_ended").map((e) => (e.type === "turn_started" ? e.cause : e.outcome)),
    ["success", "steer", "error", "command", "success"],
  );
  assert.deepEqual(only(events, "assistant_text").map((e) => e.text), ["next"]);
  await session.close();
});

test("CopilotEngine: a Steer whose cut Copilot refuses, and that the Turn then ends without running, still runs", async () => {
  const runtime = droppedSteerRuntime((s) => {
    s.emit([
      event("assistant.message", { messageId: "m2", content: "finished anyway", toolRequests: [] }),
      event("assistant.idle", {}),
    ]);
    throw new Error("interrupt failed");
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("go");
  await collect(it, (e) => e.type === "assistant_text");
  session.steer("change of plan");
  await until(() => runtime.session.interrupts === 1);
  session.send("next");
  const events = await collectTurns(it, 3);
  assert.deepEqual(
    events.filter((e) => e.type === "turn_started" || e.type === "turn_ended").map((e) => (e.type === "turn_started" ? e.cause : e.outcome)),
    ["success", "steer", "success", "command", "success"],
  );
  assert.deepEqual(only(events, "assistant_text").map((e) => e.text), ["finished anyway", "change of plan", "next"]);
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

function askUserStarts(calls: [id: string, question: string][]): SessionEvent[] {
  return calls.map(([toolCallId, question]) =>
    event("tool.execution_start", { toolCallId, toolName: "ask_user", arguments: { question, choices: ["A", "B"] } }),
  );
}

test("CopilotEngine: questions asked in parallel are each keyed to their own call", async () => {
  // Measured: both calls start before Copilot asks either question, and the
  // question handler is told nothing of which call it serves.
  const runtime = new FakeCopilotRuntime({
    onSend: (s) => {
      s.emit([
        event("user.message", { content: "go", delivery: "idle" }),
        event("assistant.turn_start", { turnId: "0" }),
        ...askUserStarts([["call-fruit", "Pick a fruit"], ["call-color", "Pick a color"]]),
      ]);
      setImmediate(() => {
        void s.ask({ question: "Pick a fruit", choices: ["A", "B"] });
        void s.ask({ question: "Pick a color", choices: ["A", "B"] });
      });
    },
  });
  const asked: EngineQuestion[] = [];
  const session = await engineOn(runtime).open({
    projectDir: "/tmp/copilot-project",
    onQuestion: (question) => (asked.push(question), new Promise<EngineAnswer>(() => undefined)),
  });
  session.send("ask me two things");
  await until(() => asked.length === 2);
  assert.deepEqual(
    asked.map((q) => [q.toolUseId, q.questions[0].question]),
    [["call-fruit", "Pick a fruit"], ["call-color", "Pick a color"]],
  );
  await session.close();
});

test("CopilotEngine: a question with no call of its own isn't keyed to an earlier question's call", async () => {
  let turn = 0;
  const runtime = new FakeCopilotRuntime({
    onSend: (s) => {
      turn += 1;
      s.emit([
        event("user.message", { content: "go", delivery: "idle" }),
        event("assistant.turn_start", { turnId: "0" }),
        ...(turn === 1 ? askUserStarts([["call-first", "First?"]]) : []),
      ]);
      setImmediate(async () => {
        await s.ask({ question: turn === 1 ? "First?" : "Second?", choices: ["A", "B"] });
        s.emit([
          ...(turn === 1 ? [event("tool.execution_complete", { toolCallId: "call-first", success: true, result: { content: "A" } })] : []),
          event("assistant.idle", {}),
        ]);
      });
    },
  });
  const asked: EngineQuestion[] = [];
  const session = await engineOn(runtime).open({
    projectDir: "/tmp/copilot-project",
    onQuestion: async (question) => (asked.push(question), { answers: { [question.questions[0].question]: "A" } }),
  });
  const it = session.events[Symbol.asyncIterator]();
  session.send("first");
  await collect(it, (e) => e.type === "turn_ended");
  session.send("second");
  await collect(it, (e) => e.type === "turn_ended");
  assert.equal(asked[0].toolUseId, "call-first");
  assert.notEqual(asked[1].toolUseId, "call-first", "the first question's call is spent");
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

/** What Copilot listed for a project with `.claude/skills/hello` and `.github/skills/ghskill` (CLI 1.0.88), trimmed, with the connector's `/clear` registered. */
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
    {
      name: "model",
      aliases: ["models"],
      description: "Select the AI model for this session (use 'auto' to let Copilot pick automatically).",
      kind: "builtin",
      input: { hint: "model" },
    },
    // The connector's own, which Copilot lists after its built-ins.
    { name: "clear", description: "Clear conversation history", kind: "client" },
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

test("CopilotEngine: the menu lists the project's and personal Copilot Skills and the Local commands, split by where they come from", async () => {
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
    { name: "clear", description: "Clear conversation history", argumentHint: "" },
    { name: "model", description: "Choose the model and its effort", argumentHint: "[model] [effort]" },
    { name: "effort", description: "Choose the model's effort", argumentHint: "[level]" },
  ]);
  await session.close();
});

test("CopilotEngine: a /clear Copilot lists as its own built-in replaces the connector's on the menu", async () => {
  const runtime = new MenuRuntime();
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  await collect(it, (e) => e.type === "menu");
  runtime.session.commands.unshift({ name: "clear", aliases: ["new"], description: "Clear the conversation", kind: "builtin" });
  runtime.session.emit([event("commands.changed", {})]);
  const [menu] = only(await collect(it, (e) => e.type === "menu"), "menu");
  assert.deepEqual(
    menu.localCommands.filter((c) => c.name === "clear"),
    [{ name: "clear", description: "Clear the conversation", argumentHint: "" }],
  );
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

test("CopilotEngine: /compact still runs as a Local command when the command list couldn't be read at open", async () => {
  class FailingReadRuntime extends MenuRuntime {
    override async createSession(options: Parameters<FakeCopilotRuntime["createSession"]>[0]) {
      const s = await super.createSession(options);
      s.failCommandReads = 1;
      return s;
    }
  }
  const runtime = new FailingReadRuntime({ onInvoke: async () => ({ kind: "text", text: "Compacted." }) });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("/compact");
  await collect(it, (e) => e.type === "turn_ended");
  assert.deepEqual(runtime.session.invoked, [{ name: "compact" }]);
  assert.deepEqual(runtime.session.sent, [], "never sent to the model as a prompt");
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

test("CopilotEngine: /clear runs the connector's own command and says the Conversation was cleared", async () => {
  // Copilot runs the connector's handler inside the command call, which
  // returns once the rewind is done, with no message of its own.
  const runtime = commandRuntime({ onInvoke: async () => ({ kind: "completed" }) });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  await collect(it, (e) => e.type === "menu");
  session.send("/clear");
  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.deepEqual(runtime.session.invoked, [{ name: "clear" }]);
  assert.deepEqual(runtime.session.sent, [], "never sent to the model as a prompt");
  assert.deepEqual(events.slice(0, -1), [
    { type: "turn_started", cause: "command" },
    { type: "status", text: "conversation cleared" },
  ]);
  assert.equal(only(events, "turn_ended")[0].outcome, "success");
  await session.close();
});

test("CopilotEngine: a /clear Copilot couldn't carry out ends its Turn with the reason, and says nothing was cleared", async () => {
  const runtime = commandRuntime({
    onInvoke: async () => {
      throw new Error("Request session.commands.invoke failed with message: Command /clear failed: session-busy");
    },
  });
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  await collect(it, (e) => e.type === "menu");
  session.send("/clear");
  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.deepEqual(only(events, "status"), []);
  const [ended] = only(events, "turn_ended");
  assert.equal(ended.outcome, "error");
  assert.deepEqual(ended.errors, ["Command /clear failed: session-busy"]);
  await session.close();
});

// --- Model picker --------------------------------------------------------------

/** Models the way Copilot lists them for a paid plan, trimmed: `auto` first, one the policy keeps from being picked. */
const MODELS = [
  { id: "auto", name: "Auto", enabled: true, efforts: [] },
  { id: "claude-opus-5.5", name: "Claude Opus 5.5", enabled: true, multiplier: 3, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { id: "gpt-5-mini", name: "GPT-5 mini", enabled: true, multiplier: 0, efforts: [] },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", enabled: false, multiplier: 1, efforts: ["low", "high"] },
];

/** An Engine on a runtime that lists {@link MODELS}, its session on `model`, answering each Question with what `pick` gives it. */
async function pickerSession(pick: (q: EngineQuestion) => EngineAnswer, model: { modelId: string; reasoningEffort?: string } = { modelId: "auto" }) {
  const runtime = new MenuRuntime();
  runtime.models = MODELS;
  const asked: EngineQuestion[] = [];
  const session = await engineOn(runtime).open({
    projectDir: "/tmp/copilot-project",
    onQuestion: async (q) => (asked.push(q), pick(q)),
  });
  runtime.session.model = model;
  const it = session.events[Symbol.asyncIterator]();
  await collect(it, (e) => e.type === "menu");
  return { runtime, session, it, asked };
}

/** Answers a one-question Question with the option whose label is `label`. */
function choose(label: string) {
  return (q: EngineQuestion): EngineAnswer => ({ answers: { [q.questions[0].question]: label } });
}

test("CopilotEngine: /model asks which model to use, offering those the plan allows, and switches to the one picked", async () => {
  const { runtime, session, it, asked } = await pickerSession(choose("GPT-5 mini"));
  session.send("/model");
  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.equal(asked.length, 1, "a model with no effort levels asks nothing more");
  assert.deepEqual(asked[0].questions, [
    {
      question: "Which model should this session use?",
      header: "Model",
      options: [
        { label: "Auto", description: "auto · current" },
        { label: "Claude Opus 5.5", description: "claude-opus-5.5 · 3×" },
        { label: "GPT-5 mini", description: "gpt-5-mini · 0×" },
      ],
      multiSelect: false,
    },
  ]);
  assert.deepEqual(runtime.session.switches, [{ modelId: "gpt-5-mini" }]);
  assert.deepEqual(runtime.session.invoked, [], "Copilot's own /model is never run");
  assert.deepEqual(runtime.session.sent, [], "never sent to the model as a prompt");
  assert.deepEqual(events.slice(0, -1), [
    { type: "turn_started", cause: "command" },
    { type: "status", text: "model set to GPT-5 mini" },
  ]);
  assert.equal(only(events, "turn_ended")[0].outcome, "success");
  await session.close();
});

test("CopilotEngine: /model then asks for the effort when the model picked takes a choice of levels", async () => {
  const answers = ["Claude Opus 5.5", "high"];
  const { runtime, session, it, asked } = await pickerSession(
    (q) => ({ answers: { [q.questions[0].question]: answers[asked.length - 1] } }),
    { modelId: "claude-opus-5.5", reasoningEffort: "low" },
  );
  session.send("/model");
  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.deepEqual(asked[1]?.questions, [
    {
      question: "Which effort should Claude Opus 5.5 use?",
      header: "Effort",
      options: [
        { label: "low", description: "current" },
        { label: "medium", description: "default" },
        { label: "high" },
      ],
      multiSelect: false,
    },
  ]);
  assert.deepEqual(runtime.session.switches, [{ modelId: "claude-opus-5.5", reasoningEffort: "high" }]);
  assert.deepEqual(only(events, "status"), [{ type: "status", text: "model set to Claude Opus 5.5 · effort high" }]);
  assert.equal(only(events, "turn_ended")[0].outcome, "success");
  await session.close();
});

test("CopilotEngine: /model with a model named switches straight to it, keeping the effort when the model takes it", async () => {
  const neverAsked = () => assert.fail("nothing should be asked");
  const cases: [string, { modelId: string; reasoningEffort?: string }, { modelId: string; reasoningEffort?: string }, string][] = [
    // By part of its name, from a model whose effort it doesn't take: its default.
    ["/model opus 5.5", { modelId: "auto" }, { modelId: "claude-opus-5.5", reasoningEffort: "medium" }, "model set to Claude Opus 5.5 · effort medium"],
    ["/model claude-opus-5.5 high", { modelId: "auto" }, { modelId: "claude-opus-5.5", reasoningEffort: "high" }, "model set to Claude Opus 5.5 · effort high"],
    ["/model Claude Opus 5.5", { modelId: "claude-opus-5.5", reasoningEffort: "low" }, { modelId: "claude-opus-5.5", reasoningEffort: "low" }, "model set to Claude Opus 5.5 · effort low"],
    // A model with no effort levels is asked for none.
    ["/models auto", { modelId: "claude-opus-5.5", reasoningEffort: "high" }, { modelId: "auto" }, "model set to Auto"],
  ];
  for (const [command, from, to, status] of cases) {
    const { runtime, session, it } = await pickerSession(neverAsked, from);
    session.send(command);
    const events = await collect(it, (e) => e.type === "turn_ended");
    assert.deepEqual(runtime.session.switches, [to], command);
    assert.deepEqual(only(events, "status"), [{ type: "status", text: status }], command);
    await session.close();
  }
});

test("CopilotEngine: a model typed into /model's picker instead of picked is switched to all the same", async () => {
  const { runtime, session, it } = await pickerSession(() => ({ answers: {}, response: "GPT-5 MINI" }));
  session.send("/model");
  await collect(it, (e) => e.type === "turn_ended");
  assert.deepEqual(runtime.session.switches, [{ modelId: "gpt-5-mini" }]);
  await session.close();
});

test("CopilotEngine: /model refuses a model the account can't use, or an effort it doesn't take, switching nothing", async () => {
  const cases: [string, string][] = [
    ["/model fable", 'no model called "fable"; this account can use auto, claude-opus-5.5, gpt-5-mini'],
    // Kept from being picked by the account's policy.
    ["/model gpt-6.1-sol", 'no model called "gpt-6.1-sol"; this account can use auto, claude-opus-5.5, gpt-5-mini'],
    ["/model claude-opus-5.5 max", 'Claude Opus 5.5 takes effort low, medium, high, not "max"'],
  ];
  for (const [command, reason] of cases) {
    const { runtime, session, it } = await pickerSession(() => assert.fail("nothing should be asked"));
    session.send(command);
    const events = await collect(it, (e) => e.type === "turn_ended");
    assert.deepEqual(runtime.session.switches, [], command);
    assert.deepEqual(only(events, "status"), [], command);
    const [ended] = only(events, "turn_ended");
    assert.equal(ended.outcome, "error", command);
    assert.deepEqual(ended.errors, [reason], command);
    await session.close();
  }
});

test("CopilotEngine: /effort asks only for the effort of the model the session is on, or sets the one named", async () => {
  const opus = { modelId: "claude-opus-5.5", reasoningEffort: "low" };
  const picked = await pickerSession(choose("high"), opus);
  picked.session.send("/effort");
  const events = await collect(picked.it, (e) => e.type === "turn_ended");
  assert.deepEqual(picked.asked.map((q) => q.questions[0].header), ["Effort"]);
  assert.deepEqual(picked.runtime.session.switches, [{ modelId: "claude-opus-5.5", reasoningEffort: "high" }]);
  assert.deepEqual(only(events, "status"), [{ type: "status", text: "effort set to high" }]);
  await picked.session.close();

  const named = await pickerSession(() => assert.fail("nothing should be asked"), opus);
  named.session.send("/effort Medium");
  await collect(named.it, (e) => e.type === "turn_ended");
  assert.deepEqual(named.runtime.session.switches, [{ modelId: "claude-opus-5.5", reasoningEffort: "medium" }]);
  await named.session.close();
});

test("CopilotEngine: /effort refuses on a model with no effort levels, or a level the model doesn't take", async () => {
  const cases: [string, { modelId: string; reasoningEffort?: string }, string][] = [
    ["/effort", { modelId: "auto" }, "Auto has no effort levels to choose from"],
    ["/effort max", { modelId: "claude-opus-5.5", reasoningEffort: "low" }, 'Claude Opus 5.5 takes effort low, medium, high, not "max"'],
  ];
  for (const [command, model, reason] of cases) {
    const { runtime, session, it } = await pickerSession(() => assert.fail("nothing should be asked"), model);
    session.send(command);
    const [ended] = only(await collect(it, (e) => e.type === "turn_ended"), "turn_ended");
    assert.deepEqual(runtime.session.switches, [], command);
    assert.equal(ended.outcome, "error", command);
    assert.deepEqual(ended.errors, [reason], command);
    await session.close();
  }
});

test("CopilotEngine: a switch Copilot refuses, or a model list it can't give, ends /model's Turn with the reason", async () => {
  const refused = await pickerSession(() => assert.fail("nothing should be asked"));
  refused.runtime.session.switchError = new Error("Request session.model.switchTo failed with message: Model is not available on your plan");
  refused.session.send("/model gpt-5-mini");
  const [switchEnded] = only(await collect(refused.it, (e) => e.type === "turn_ended"), "turn_ended");
  assert.equal(switchEnded.outcome, "error");
  assert.deepEqual(switchEnded.errors, ["Model is not available on your plan"]);
  await refused.session.close();

  const unlisted = await pickerSession(() => assert.fail("nothing should be asked"));
  unlisted.runtime.modelsError = new Error("Not authenticated");
  unlisted.session.send("/model");
  const events = await collect(unlisted.it, (e) => e.type === "turn_ended");
  assert.deepEqual(only(events, "status"), []);
  assert.deepEqual(only(events, "turn_ended")[0].errors, ["Not authenticated"]);
  assert.deepEqual(unlisted.runtime.session.switches, []);
  await unlisted.session.close();
});

test("CopilotEngine: Stop with /model's picker open cancels it: no switch, nothing said, nothing of Copilot's aborted", async () => {
  let signal: AbortSignal | undefined;
  const runtime = new MenuRuntime();
  runtime.models = MODELS;
  const session = await engineOn(runtime).open({
    projectDir: "/tmp/copilot-project",
    onQuestion: (_q, sig) => {
      signal = sig;
      return new Promise<EngineAnswer>((_resolve, reject) => sig.addEventListener("abort", () => reject(new Error("turn stopped"))));
    },
  });
  const it = session.events[Symbol.asyncIterator]();
  await collect(it, (e) => e.type === "menu");
  session.send("/model");
  await until(() => signal !== undefined);
  session.stop();
  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.equal(only(events, "turn_ended")[0].outcome, "stopped");
  assert.equal(signal?.aborted, true, "the picker's Question is withdrawn");
  assert.deepEqual(only(events, "status"), []);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(runtime.session.switches, []);
  assert.equal(runtime.session.aborts, 0, "Copilot had nothing running to abort");
  await session.close();
});

test("CopilotEngine: Stop before /model has its models to offer asks nothing and switches nothing", async () => {
  for (const command of ["/model", "/model gpt-5-mini"]) {
    let release!: () => void;
    const { runtime, session, it, asked } = await pickerSession(choose("GPT-5 mini"));
    runtime.modelsGate = new Promise((r) => (release = r));
    session.send(command);
    await until(() => runtime.modelReads === 1);
    session.stop();
    const events = await collect(it, (e) => e.type === "turn_ended");
    assert.equal(only(events, "turn_ended")[0].outcome, "stopped", command);
    release();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(asked, [], command);
    assert.deepEqual(runtime.session.switches, [], command);
    await session.close();
  }
});

test("CopilotEngine: /model runs as the connector's own even when Copilot's command list can't be read", async () => {
  class UnreadableMenuRuntime extends FakeCopilotRuntime {
    override async createSession(options: Parameters<FakeCopilotRuntime["createSession"]>[0]) {
      const s = await super.createSession(options);
      s.failCommandReads = 2;
      return s;
    }
  }
  const runtime = new UnreadableMenuRuntime();
  runtime.models = MODELS;
  const session = await engineOn(runtime).open(openOptions());
  const it = session.events[Symbol.asyncIterator]();
  session.send("/model gpt-5-mini");
  await collect(it, (e) => e.type === "turn_ended");
  assert.deepEqual(runtime.session.switches, [{ modelId: "gpt-5-mini" }]);
  assert.deepEqual(runtime.session.sent, [], "never sent to the model as a prompt");
  await session.close();
});

test("CopilotEngine: a model /model switched to isn't announced again when the next Turn starts", async () => {
  const { runtime, session, it } = await pickerSession(choose("GPT-5 mini"));
  session.send("/model");
  await collect(it, (e) => e.type === "turn_ended");
  session.send("hello");
  await until(() => runtime.session.sent.length === 1);
  // A named model, unlike `auto`, isn't resolved again per Turn.
  runtime.session.emit(simpleTurn("hi", "gpt-5-mini").filter((e) => e.type !== "session.auto_mode_resolved"));
  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.deepEqual(only(events, "announce"), []);
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

test("CopilotEngine: reports it can Steer", () => {
  assert.equal(engineOn(new FakeCopilotRuntime()).capabilities.steer, true);
});

// --- show_image forwards to onShowImage -------------------------------------

/** Opens a session with the given `onShowImage`, on a fake runtime whose session the test then drives. */
async function openWithShowImage(
  onShowImage: (image: EngineImage, signal: AbortSignal) => Promise<ShowImageOutcome>,
): Promise<{ runtime: FakeCopilotRuntime; close(): Promise<void> }> {
  const runtime = new FakeCopilotRuntime();
  const session = await engineOn(runtime).open({ ...openOptions(), onShowImage });
  return { runtime, close: () => session.close() };
}

test("CopilotEngine: show_image is registered, and a call reaches onShowImage with its tool call's id", async () => {
  const received: { image: EngineImage; signal: AbortSignal }[] = [];
  const { runtime, close } = await openWithShowImage(async (image, signal) => {
    received.push({ image, signal });
    return { shown: true };
  });

  const tool = runtime.session.options.tools?.find((t) => t.name === "show_image");
  assert.ok(tool, "show_image is offered to the Engine");
  assert.deepEqual((tool.parameters as { required?: string[] }).required, ["path"]);

  const signal = new AbortController().signal;
  const reply = await runtime.session.callTool(
    "show_image",
    { path: "/tmp/shot.png", caption: "the login page" },
    "call_img",
    signal,
  );

  assert.deepEqual(
    received.map((r) => r.image),
    [{ toolUseId: "call_img", path: "/tmp/shot.png", caption: "the login page" }],
  );
  assert.equal(received[0].signal, signal, "the call's own signal, which the SDK aborts when the call is over");
  assert.ok("result" in reply && typeof reply.result === "object", `a tool result came back: ${JSON.stringify(reply)}`);
  assert.equal(reply.result.resultType, "success");
  assert.equal(reply.result.binaryResultsForLlm, undefined, "only text goes back to the model, never the image");
  await close();
});

test("CopilotEngine: a show_image with no caption reaches onShowImage without one", async () => {
  const received: EngineImage[] = [];
  const { runtime, close } = await openWithShowImage(async (image) => {
    received.push(image);
    return { shown: true };
  });

  await runtime.session.callTool("show_image", { path: "/tmp/shot.png" }, "call_img");

  assert.deepEqual(received, [{ toolUseId: "call_img", path: "/tmp/shot.png" }]);
  await close();
});

test("CopilotEngine: a show_image that fails comes back to the Engine as a failure carrying the reason", async () => {
  const { runtime, close } = await openWithShowImage(async () => ({ shown: false, reason: "not a PNG" }));

  const reply = await runtime.session.callTool("show_image", { path: "/tmp/notes.txt" }, "call_img");

  assert.ok("result" in reply && typeof reply.result === "object", `a tool result came back: ${JSON.stringify(reply)}`);
  assert.equal(reply.result.resultType, "failure");
  assert.equal(reply.result.textResultForLlm, "not a PNG");
  assert.equal(reply.result.error, "not a PNG");
  await close();
});

test("CopilotEngine: a show_image whose onShowImage throws comes back as a failure carrying the message", async () => {
  const { runtime, close } = await openWithShowImage(async () => {
    throw new Error("relay unreachable");
  });

  const reply = await runtime.session.callTool("show_image", { path: "/tmp/shot.png" }, "call_img");

  assert.ok("result" in reply && typeof reply.result === "object", `a tool result came back: ${JSON.stringify(reply)}`);
  assert.equal(reply.result.resultType, "failure");
  assert.equal(reply.result.textResultForLlm, "relay unreachable");
  await close();
});

test("CopilotEngine: a resumed Conversation is offered show_image too", async () => {
  const runtime = new FakeCopilotRuntime();
  runtime.known.add("copilot-earlier");
  const session = await engineOn(runtime).open({
    ...openOptions({ resume: "copilot-earlier" }),
    onShowImage: async () => ({ shown: true }),
  });

  assert.ok(runtime.session.options.tools?.some((t) => t.name === "show_image"));
  await session.close();
});

test("CopilotEngine: a session opened without onShowImage offers no show_image tool", async () => {
  const runtime = new FakeCopilotRuntime();
  const session = await engineOn(runtime).open(openOptions());

  assert.ok(!runtime.session.options.tools?.some((t) => t.name === "show_image"));
  await session.close();
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
