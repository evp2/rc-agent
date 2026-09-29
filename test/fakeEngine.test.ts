import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FakeEngine,
  askAndFinish,
  compactAndFinish,
  failWith,
  hangUntilStopped,
  sayAndFinish,
  startBackgroundTaskAndFinish,
  useToolAndFinish,
  type FakeEngineSession,
} from "../src/engine/fakeEngine.ts";
import { IMAGE_SHOWN } from "../src/engine/showImageTool.ts";
import type { EngineAnswer, EngineEvent, EngineQuestion } from "../src/engine/types.ts";
import {
  runEngineGuaranteeSuite,
  SHOW_IMAGE_CALL,
  type EngineGuaranteeHarness,
  type ShowImageToolResult,
} from "./engineGuaranteeSuite.ts";

function noQuestionsExpected() {
  return () => new Promise<EngineAnswer>(() => undefined);
}

const harness: EngineGuaranteeHarness = {
  makeSimpleEngine: () =>
    new FakeEngine({ handlerFor: () => sayAndFinish("hi") }),

  makeErroringEngine: () =>
    new FakeEngine({ handlerFor: () => failWith("boom") }),

  makeHangingEngine: () =>
    new FakeEngine({ handlerFor: () => hangUntilStopped() }),

  makeQueueingEngine: () =>
    new FakeEngine({
      handlerFor: (_cause, text) => sayAndFinish(text === "second" ? "second done" : "first done"),
    }),

  makeSteerableEngine: () =>
    new FakeEngine({
      handlerFor: (cause) => (cause === "steer" ? sayAndFinish("corrected") : hangUntilStopped()),
    }),

  makeBackgroundTaskEngine: () =>
    new FakeEngine({
      handlerFor: () => async (ctx) => {
        ctx.emit({ type: "task_started", taskId: "bg-1", description: "a long job", ambient: false });
        await ctx.waitForStop();
        // Mirrors a real Engine, whose abort kills its Background children
        // too -- with no further event ever coming from them on its own.
        ctx.emit({ type: "task_settled", taskId: "bg-1", status: "stopped", ambient: false });
        return { outcome: "stopped" };
      },
    }),

  makeShowImageEngine: () => {
    let seen: ShowImageToolResult | undefined;
    const engine = new FakeEngine({
      handlerFor: () => async (ctx) => {
        const outcome = await ctx.showImage(SHOW_IMAGE_CALL);
        seen = outcome.shown ? { text: IMAGE_SHOWN, isError: false } : { text: outcome.reason, isError: true };
        return { outcome: "success" };
      },
    });
    return { engine, toolResult: () => seen };
  },
};

runEngineGuaranteeSuite("FakeEngine", harness);

test("FakeEngine: a Question is answered through onQuestion and the Turn continues", async () => {
  const question: EngineQuestion = {
    toolUseId: "toolu_1",
    questions: [{ question: "Proceed?", options: [{ label: "Yes" }], multiSelect: false }],
  };
  const engine = new FakeEngine({ handlerFor: () => askAndFinish(question) });
  const session = await engine.open({
    projectDir: "/tmp/x",
    onQuestion: async (q) => {
      assert.deepEqual(q, question);
      return { answers: { [q.questions[0].question]: "Yes" } };
    },
  });
  const it = session.events[Symbol.asyncIterator]();
  session.send("ask it");
  const events = await collect(it, (e) => e.type === "turn_ended");
  const text = events.find((e) => e.type === "assistant_text");
  assert.ok(text && text.text.includes("Yes"));
  await session.close();
});

test("FakeEngine: Stop aborts a pending Question's signal", async () => {
  const question: EngineQuestion = {
    toolUseId: "toolu_1",
    questions: [{ question: "Proceed?", options: [{ label: "Yes" }], multiSelect: false }],
  };
  let sawAbort = false;
  const engine = new FakeEngine({ handlerFor: () => askAndFinish(question) });
  const session = await engine.open({
    projectDir: "/tmp/x",
    onQuestion: (_q, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          sawAbort = true;
          reject(new Error("stopped"));
        });
      }),
  });
  const it = session.events[Symbol.asyncIterator]();
  session.send("ask it");
  // Give the handler a tick to reach ctx.ask() before stopping.
  await new Promise((r) => setTimeout(r, 10));
  session.stop();
  await collect(it, (e) => e.type === "turn_ended");
  assert.ok(sawAbort);
  await session.close();
});

test("FakeEngine: a Background task's start and settle are both scriptable", async () => {
  let resolveSettle: () => void = () => undefined;
  const settleAfter = new Promise<void>((resolve) => {
    resolveSettle = resolve;
  });
  const engine = new FakeEngine({
    handlerFor: () => startBackgroundTaskAndFinish("bg-1", settleAfter, { description: "sleep" }),
  });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("go");
  const afterTurn = await collect(it, (e) => e.type === "turn_ended");
  assert.ok(afterTurn.some((e) => e.type === "task_started"));
  assert.ok(!afterTurn.some((e) => e.type === "task_settled"), "the Turn ends before the task settles");
  resolveSettle();
  const rest = await collect(it, (e) => e.type === "task_settled");
  assert.equal((rest.find((e) => e.type === "task_settled") as Extract<EngineEvent, { type: "task_settled" }>).status, "completed");
  await session.close();
});

test("FakeEngine: compaction is scriptable, with the context percentage stamped", async () => {
  const engine = new FakeEngine({ handlerFor: () => compactAndFinish(12000, 3000, 40) });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("/compact");
  const events = await collect(it, (e) => e.type === "turn_ended");
  const compacting = events.find((e) => e.type === "compacting");
  const compacted = events.find((e) => e.type === "compacted");
  assert.ok(compacting && compacting.trigger === "auto");
  assert.ok(compacted && compacted.preTokens === 12000 && compacted.postTokens === 3000);
  const ended = events.find((e) => e.type === "turn_ended") as Extract<EngineEvent, { type: "turn_ended" }>;
  assert.equal(ended.contextPercentage, 40);
  await session.close();
});

test("FakeEngine: a tool call and its result are scriptable", async () => {
  const engine = new FakeEngine({ handlerFor: () => useToolAndFinish("Bash", { command: "echo hi" }, "hi") });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("run it");
  const events = await collect(it, (e) => e.type === "turn_ended");
  const toolUse = events.find((e) => e.type === "tool_use") as Extract<EngineEvent, { type: "tool_use" }>;
  const toolResult = events.find((e) => e.type === "tool_result") as Extract<EngineEvent, { type: "tool_result" }>;
  assert.equal(toolUse.name, "Bash");
  assert.equal(toolResult.toolUseId, toolUse.toolUseId);
  assert.equal(toolResult.text, "hi");
  await session.close();
});

test("FakeEngine: an Engine-started Turn carries cause \"engine\" and no Command triggered it", async () => {
  const engine = new FakeEngine({ handlerFor: () => sayAndFinish("I noticed something") });
  const session = (await engine.open({
    projectDir: "/tmp/x",
    onQuestion: noQuestionsExpected(),
  })) as FakeEngineSession;
  const it = session.events[Symbol.asyncIterator]();
  session.triggerEngineTurn();
  const events = await collect(it, (e) => e.type === "turn_ended");
  const started = events.find((e) => e.type === "turn_started") as Extract<EngineEvent, { type: "turn_started" }>;
  assert.equal(started.cause, "engine");
  await session.close();
});

test("FakeEngine: steer() throws when nothing is running, and never starts a Turn", async () => {
  const engine = new FakeEngine({ handlerFor: () => sayAndFinish("hi") });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  assert.throws(() => session.steer("too late"));
  await session.close();
});

test("FakeEngine: steer() throws when the Engine cannot Steer", async () => {
  const engine = new FakeEngine({ handlerFor: () => hangUntilStopped(), capabilities: { steer: false } });
  assert.equal(engine.capabilities.steer, false);
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  session.send("go");
  await new Promise((r) => setTimeout(r, 10));
  assert.throws(() => session.steer("nope"));
  session.stop();
  await session.close();
});

test("FakeEngine: close() does not hang when a Command is queued behind a hanging Turn", async () => {
  const engine = new FakeEngine({ handlerFor: () => hangUntilStopped() });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  session.send("first");
  await new Promise((r) => setTimeout(r, 10));
  session.send("second"); // queues behind "first"; must never get its own Turn once closed
  await session.close();
});

test("FakeEngine: forkConversation defaults to carrying the same id, and is overridable", async () => {
  const defaultEngine = new FakeEngine({ handlerFor: () => sayAndFinish("hi") });
  assert.equal(
    await defaultEngine.forkConversation({ conversationId: "abc", fromDir: "/a", toDir: "/b" }),
    "abc",
  );

  const noCarry = new FakeEngine({ handlerFor: () => sayAndFinish("hi"), forkConversation: async () => undefined });
  assert.equal(await noCarry.forkConversation({ conversationId: "abc", fromDir: "/a", toDir: "/b" }), undefined);
});

// --- local test helper ------------------------------------------------------

const TIMED_OUT = Symbol("timed out");

async function collect(
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
    if (result === TIMED_OUT) throw new Error(`timed out; collected: ${JSON.stringify(collected)}`);
    if (result.done) throw new Error(`stream ended; collected: ${JSON.stringify(collected)}`);
    collected.push(result.value);
    if (predicate(result.value)) return collected;
  }
}

test("FakeEngine: a Turn whose Question is aborted by Stop ends as stopped, not as an error", async () => {
  const engine = new FakeEngine({
    handlerFor: () => askAndFinish({ toolUseId: "q1", questions: [] }),
  });
  const session = await engine.open({
    projectDir: "/tmp/x",
    onQuestion: (_q, signal) =>
      new Promise<EngineAnswer>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("turn stopped")), { once: true });
        session.stop();
      }),
  });
  const events: EngineEvent[] = [];
  session.send("ask");
  for await (const e of session.events) {
    events.push(e);
    if (e.type === "turn_ended") break;
  }
  const ended = events.find((e) => e.type === "turn_ended") as Extract<EngineEvent, { type: "turn_ended" }>;
  assert.equal(ended.outcome, "stopped");
  await session.close();
});

test("FakeEngine: a handler can wait for its Turn to be cut short by a Steer, so it stops working", async () => {
  const afterSteer: string[] = [];
  const engine = new FakeEngine({
    handlerFor: (cause) =>
      cause === "steer"
        ? sayAndFinish("corrected")
        : async (ctx) => {
            await ctx.waitForInterruption();
            afterSteer.push(ctx.stopped ? "stopped" : "steered");
            return { outcome: "success" };
          },
  });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("first");
  await it.next(); // conversation
  await it.next(); // turn_started
  session.steer("a correction");
  for (;;) {
    const { value } = await it.next();
    if (value?.type === "turn_ended" && afterSteer.length) break;
  }
  assert.deepEqual(afterSteer, ["steered"]);
  await session.close();
});

test("FakeEngine: beforeSteerConfirm runs inside the truncated Turn, and a Stop there cancels the Steer's Turn", async () => {
  const engine = new FakeEngine({
    handlerFor: (cause) => (cause === "steer" ? sayAndFinish("corrected") : hangUntilStopped()),
    beforeSteerConfirm: async (ctx) => {
      ctx.emit({ type: "assistant_text", text: "holding" });
      await ctx.waitForStop();
    },
  });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const events: EngineEvent[] = [];
  session.send("first");
  for await (const e of session.events) {
    events.push(e);
    if (e.type === "turn_started" && events.filter((x) => x.type === "turn_started").length === 1) {
      session.steer("a correction");
    }
    if (e.type === "assistant_text" && e.text === "holding") session.stop();
    if (e.type === "turn_ended") break;
  }
  assert.deepEqual(
    events.filter((e) => e.type === "turn_started" || e.type === "turn_ended").map((e) => e.type),
    ["turn_started", "turn_ended"],
  );
  assert.equal((events.at(-1) as Extract<EngineEvent, { type: "turn_ended" }>).outcome, "stopped");
  await session.close();
});
