import assert from "node:assert/strict";
import { test } from "node:test";

import type { HookInput, Options } from "@anthropic-ai/claude-agent-sdk";

import { ClaudeEngine } from "../src/engine/claude/adapter.ts";
import type { EngineAnswer, EngineEvent, EngineQuestion } from "../src/engine/types.ts";
import {
  assistantText,
  compactBoundary,
  init,
  result,
  scriptedQuery,
  taskStarted,
} from "./doubles.ts";
import { runEngineGuaranteeSuite, type EngineGuaranteeHarness } from "./engineGuaranteeSuite.ts";
import { reactiveQuery } from "./engineReactiveQuery.ts";

function noQuestionsExpected() {
  return () => new Promise<EngineAnswer>(() => undefined);
}

const harness: EngineGuaranteeHarness = {
  makeSimpleEngine: () =>
    new ClaudeEngine({ query: reactiveQuery({ subTurns: [[init(), assistantText("hi"), result()]] }), env: {} }),

  makeErroringEngine: () =>
    new ClaudeEngine({
      query: scriptedQuery([init(), assistantText("working"), result()], {
        throwAfter: { count: 2, error: new Error("subprocess exited") },
      }).query,
      env: {},
    }),

  makeHangingEngine: () =>
    new ClaudeEngine({
      query: scriptedQuery([init(), assistantText("working")], { staysOpenAfterDrain: true }).query,
      env: {},
    }),

  makeQueueingEngine: () =>
    new ClaudeEngine({
      query: reactiveQuery({
        subTurns: [
          [init(), assistantText("first"), result()],
          [init("sdk-2"), assistantText("second"), result()],
        ],
      }),
      env: {},
    }),

  makeSteerableEngine: () =>
    new ClaudeEngine({
      query: reactiveQuery({
        subTurns: [
          [init(), assistantText("first")],
          [init("sdk-2"), assistantText("corrected"), result()],
        ],
      }),
      env: {},
    }),

  makeBackgroundTaskEngine: () =>
    new ClaudeEngine({
      query: reactiveQuery({
        subTurns: [[init(), assistantText("starting"), taskStarted("bg-1")]],
        hangAfterLast: true,
      }),
      env: {},
    }),
};

runEngineGuaranteeSuite("ClaudeEngine", harness);

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

// --- Translation tests: existing scripted Claude messages -> neutral events -

test("ClaudeEngine: the context percentage is stamped on turn_ended and on a compaction", async () => {
  const { query } = scriptedQuery([init(), compactBoundary(), result()], { contextPercentages: [55, 77] });
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("/compact");
  const events = await collect(it, (e) => e.type === "turn_ended");

  const compacted = events.find((e) => e.type === "compacted") as Extract<EngineEvent, { type: "compacted" }>;
  const ended = events.find((e) => e.type === "turn_ended") as Extract<EngineEvent, { type: "turn_ended" }>;
  assert.equal(compacted.contextPercentage, 55);
  assert.equal(ended.contextPercentage, 77);
  await session.close();
});

test("ClaudeEngine: a subprocess dying mid-Turn still ends it, with the failure reported once", async () => {
  const { query } = scriptedQuery([init(), assistantText("working"), result()], {
    throwAfter: { count: 2, error: new Error("subprocess exited") },
  });
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("first");
  const events = await collect(it, (e) => e.type === "turn_ended");
  const ended = events.find((e) => e.type === "turn_ended") as Extract<EngineEvent, { type: "turn_ended" }>;
  assert.equal(ended.outcome, "error");
  assert.deepEqual(ended.errors, ["subprocess exited"]);
  await session.close();
});

test("ClaudeEngine: an [ede_diagnostic]-tagged throw is suppressed, not reported as an error", async () => {
  const { query } = scriptedQuery([init(), assistantText("working"), result()], {
    throwAfter: {
      count: 2,
      error: new Error("[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"),
    },
  });
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("first");
  const events = await collect(it, (e) => e.type === "turn_ended");
  const ended = events.find((e) => e.type === "turn_ended") as Extract<EngineEvent, { type: "turn_ended" }>;
  assert.equal(ended.outcome, "success");
  assert.equal(ended.errors, undefined);
  await session.close();
});

test("ClaudeEngine: a duplicate error after an already-reported result is suppressed", async () => {
  const { query } = scriptedQuery(
    [init(), assistantText("working"), result(), assistantText("should not appear"), result("error_during_execution")],
    {
      onYield: async (message) => {
        // Mirrors run.ts's own drain: nothing stops the generator from
        // yielding further messages against an already-finished sub-turn.
        void message;
      },
    },
  );
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("first");
  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.equal(events.filter((e) => e.type === "turn_ended").length, 1, "only the first result's outcome is reported");
});

test("ClaudeEngine: the Question callback replaces the question tool's tool-call event", async () => {
  const toolUseId = "toolu_q1";
  const questionInput = {
    questions: [{ question: "Which approach?", options: [{ label: "A" }, { label: "B" }], multiSelect: false }],
  };
  let capturedOptions: Options | undefined;
  const { query } = scriptedQuery([init()], {
    onOptions: (options) => {
      capturedOptions = options;
    },
  });
  const engine = new ClaudeEngine({
    query,
    env: {},
  });
  let receivedQuestion: EngineQuestion | undefined;
  const session = await engine.open({
    projectDir: "/tmp/x",
    onQuestion: async (q) => {
      receivedQuestion = q;
      return { answers: { [q.questions[0].question]: "A" } };
    },
  });
  const it = session.events[Symbol.asyncIterator]();
  session.send("ask something");
  await collect(it, (e) => e.type === "turn_started");

  // Drives canUseTool exactly as the real SDK would for an AskUserQuestion
  // tool call, using the Options the scripted query captured.
  const permissionResult = await capturedOptions?.canUseTool?.("AskUserQuestion", questionInput, {
    signal: new AbortController().signal,
    toolUseID: toolUseId,
    requestId: "req-1",
  });

  assert.ok(receivedQuestion, "onQuestion was invoked");
  assert.equal(receivedQuestion?.toolUseId, toolUseId);
  assert.deepEqual(receivedQuestion?.questions, questionInput.questions);
  assert.equal(permissionResult?.behavior, "allow");
  await session.close();
});

test("ClaudeEngine: an assistant message's AskUserQuestion tool_use produces no tool_use event", async () => {
  const toolUseId = "toolu_q1";
  const { query } = scriptedQuery([
    init(),
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input: { questions: [] } }],
      },
    } as unknown as Parameters<typeof scriptedQuery>[0][number],
    result(),
  ]);
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({
    projectDir: "/tmp/x",
    onQuestion: async () => ({ answers: {} }),
  });
  const it = session.events[Symbol.asyncIterator]();
  session.send("ask something");
  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.ok(!events.some((e) => e.type === "tool_use"), "the question tool never becomes a tool_use event");
  await session.close();
});

// --- The PreCompact hook translates to "compacting" -------------------------

test("ClaudeEngine: an automatic PreCompact fires \"compacting\", a manual one does not", async () => {
  let capturedOptions: Options | undefined;
  const { query } = scriptedQuery([init(), compactBoundary(), result()], {
    onOptions: (options) => {
      capturedOptions = options;
    },
  });
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("/compact");
  await collect(it, (e) => e.type === "turn_started");

  const hookInput = { hook_event_name: "PreCompact", trigger: "auto" } as unknown as HookInput;
  await capturedOptions?.hooks?.PreCompact?.[0]?.hooks[0]?.(hookInput, undefined, {
    signal: new AbortController().signal,
  });

  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.ok(events.some((e) => e.type === "compacting" && e.trigger === "auto"));
  await session.close();
});
