import assert from "node:assert/strict";
import { test } from "node:test";

import { approveEverything, CopilotEngine } from "../src/engine/copilot/adapter.ts";
import type { CopilotRuntime } from "../src/engine/copilot/runtime.ts";
import type { EngineAnswer, EngineEvent } from "../src/engine/types.ts";
import {
  event,
  FakeCopilotRuntime,
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

  // Copilot doesn't Steer yet, so the suite skips its Steer-ordering check.
  makeSteerableEngine: () => engineOn(new FakeCopilotRuntime({ onSend: (s) => s.emit(simpleTurn()) })),

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

test("CopilotEngine: reports it can't Steer", () => {
  assert.equal(engineOn(new FakeCopilotRuntime()).capabilities.steer, false);
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
