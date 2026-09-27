import assert from "node:assert/strict";
import { test } from "node:test";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { ClaudeEngine } from "../src/engine/claude/adapter.ts";
import { sayAndFinish, startBackgroundTaskAndFinish, type FakeTurnHandler } from "../src/engine/fakeEngine.ts";
import { maybeSubmitAutoCompact } from "../src/session/loop.ts";
import { runTurn } from "../src/session/turn.ts";
import { assistantText, init, result, scriptedQuery, taskStarted } from "./claudeDoubles.ts";
import { cmd, makeTurnHarness, until, type TurnHarness } from "./doubles.ts";

const completes = (h: TurnHarness) => h.ctx.eventBuffer.filter((e) => e.type === "turn_complete");
const indexOfText = (h: TurnHarness, text: string) => h.ctx.eventBuffer.findIndex((e) => e.text === text);

test("a Turn the Engine starts after a Background task finishes is preceded by a line naming that task", async () => {
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const h = await makeTurnHarness({
    handlerFor: (cause) =>
      cause === "engine"
        ? sayAndFinish("the tests passed")
        : startBackgroundTaskAndFinish("bg-1", settled, { description: "npm test" }),
  });
  await runTurn(h.ctx, cmd("run the tests in the background"));
  settle();
  await until(() => h.ctx.eventBuffer.some((e) => e.type === "background_task_settled"));

  h.session.triggerEngineTurn();
  await until(() => completes(h).length === 2);

  const line = indexOfText(h, "working again: npm test finished");
  assert.notEqual(line, -1);
  assert.equal(h.ctx.eventBuffer[line].type, "status");
  assert.ok(line < indexOfText(h, "the tests passed"), "the line comes before the Turn's own output");
  await h.close();
});

test("a Turn the Engine starts with no known cause says it is working again on its own", async () => {
  const h = await makeTurnHarness({ handlerFor: () => sayAndFinish("carrying on") });

  h.session.triggerEngineTurn();
  await until(() => completes(h).length === 1);

  const line = indexOfText(h, "working again on its own");
  assert.notEqual(line, -1);
  assert.ok(line < indexOfText(h, "carrying on"));
  await h.close();
});

/** A Turn that says it is working, then waits until `gate` resolves before finishing. */
function workUntil(gate: Promise<void>): FakeTurnHandler {
  return async (ctx) => {
    ctx.emit({ type: "assistant_text", text: "working" });
    await Promise.race([gate, ctx.waitForInterruption()]);
    return ctx.stopped ? { outcome: "stopped" } : { outcome: "success" };
  };
}

function gate(): { opened: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

test("a Turn the Engine starts on its own is In flight for the whole Turn, and not afterwards", async () => {
  const g = gate();
  const h = await makeTurnHarness({ handlerFor: () => workUntil(g.opened) });

  h.session.triggerEngineTurn();
  await until(() => h.ctx.eventBuffer.some((e) => e.text === "working"));
  await until(() => h.relay.reports.length === 1);
  assert.deepEqual(h.relay.reports, [true], "the phone offers the brake while it runs");
  await h.ledger.reconcileOnce();
  assert.equal(h.relay.lastReport, true, "a reconcile mid-Turn re-asserts it rather than correcting it away");

  g.open();
  await until(() => completes(h).length === 1);
  await until(() => h.relay.lastReport === false);
  assert.equal(h.ledger.snapshot(), undefined, "no Command is held, so a restart has nothing to report");
  await h.ledger.reconcileOnce();
  assert.equal(h.relay.lastReport, false);
  await h.close();
});

test("a Turn the Engine starts on its own sends no push when it ends", async () => {
  const h = await makeTurnHarness({ handlerFor: () => sayAndFinish("carrying on") });

  h.session.triggerEngineTurn();
  await until(() => completes(h).length === 1);

  assert.equal(completes(h)[0].no_notify, true);
  await h.close();
});

test("a Turn the Engine starts on its own leaves Auto-compact's idle clock alone", async () => {
  const h = await makeTurnHarness({ handlerFor: () => sayAndFinish("ok") });
  await runTurn(h.ctx, cmd("a real Command"));
  const lastReal = h.ctx.state.lastRealTurnCompletedAt;
  assert.ok(lastReal, "the real Command's Turn started the idle clock");

  await new Promise((resolve) => setTimeout(resolve, 5));
  h.session.triggerEngineTurn();
  await until(() => completes(h).length === 2);
  await until(() => h.relay.lastReport === false);

  assert.equal(h.ctx.state.lastRealTurnCompletedAt, lastReal);
  await h.close();
});

/** A Turn that works until a Steer or a Stop cuts it short. */
const workUntilInterrupted: FakeTurnHandler = async (ctx) => {
  ctx.emit({ type: "assistant_text", text: "working" });
  await ctx.waitForInterruption();
  return ctx.stopped ? { outcome: "stopped" } : { outcome: "success" };
};

test("a Command arriving during a Turn the Engine started on its own Steers it", async () => {
  const causes: string[] = [];
  const h = await makeTurnHarness({
    handlerFor: (cause, text) => {
      causes.push(cause);
      return cause === "engine" ? workUntilInterrupted : sayAndFinish(`on it: ${text}`);
    },
  });
  h.session.triggerEngineTurn();
  await until(() => h.ctx.eventBuffer.some((e) => e.text === "working"));
  await until(() => h.relay.reports.length === 1);

  await runTurn(h.ctx, cmd("stop that and do this"));

  assert.deepEqual(causes, ["engine", "steer"], "delivered as a Steer, not queued behind the Turn");
  const steered = indexOfText(h, "steered");
  const [engineComplete, commandComplete] = completes(h);
  assert.ok(steered !== -1 && steered < h.ctx.eventBuffer.indexOf(engineComplete), "the cut-short Turn is marked steered");
  assert.equal(engineComplete.no_notify, true);
  assert.equal(commandComplete.no_notify, undefined, "the human's own Command still gets its push");
  assert.ok(h.ctx.eventBuffer.some((e) => e.text === "on it: stop that and do this"));
  assert.ok(h.ctx.state.lastRealTurnCompletedAt, "the human showed up, so the idle clock restarts");
  assert.deepEqual(h.relay.reports, [true, false], "In flight throughout, with no flicker between the two Turns");
  assert.equal(h.ledger.snapshot(), undefined);
  await h.close();
});

test("the brake stops a Turn the Engine started on its own", async () => {
  const h = await makeTurnHarness({ handlerFor: () => workUntilInterrupted });
  h.session.triggerEngineTurn();
  await until(() => h.ctx.eventBuffer.some((e) => e.text === "working"));

  const tappedAt = new Date(Date.now() + 1000).toISOString();
  h.relay.getSession = async () => ({ interrupt_at: tappedAt });
  await until(() => completes(h).length === 1, 5000);

  assert.notEqual(indexOfText(h, "turn stopped"), -1);
  await until(() => h.relay.lastReport === false);
  assert.deepEqual(h.relay.reports, [true, false]);
  await h.close();
});

test("a Stop while a Command's Steer into the Engine's own Turn is pending discards the Command, visibly", async () => {
  const h = await makeTurnHarness({
    handlerFor: (cause) => (cause === "engine" ? workUntilInterrupted : sayAndFinish("should never run")),
    script: {
      beforeSteerConfirm: async (turn) => {
        h.ctx.currentTurn!.abortController.abort();
        await turn.waitForStop();
      },
    },
  });
  h.session.triggerEngineTurn();
  await until(() => h.ctx.eventBuffer.some((e) => e.text === "working"));

  await runTurn(h.ctx, cmd("do this instead"));

  assert.ok(h.ctx.eventBuffer.some((e) => e.type === "command_discarded" && e.text === "do this instead"));
  assert.ok(!h.ctx.eventBuffer.some((e) => e.text === "should never run"));
  await until(() => h.relay.lastReport === false);
  assert.equal(h.ledger.snapshot(), undefined);
  await h.close();
});

test("Auto-compact waits while a Turn the Engine started on its own is running", async () => {
  const g = gate();
  const h = await makeTurnHarness({
    handlerFor: () => workUntil(g.opened),
    config: { inactivityCompact: { afterMinutes: 30 } },
  });
  h.ctx.state.lastRealTurnCompletedAt = new Date(Date.now() - 31 * 60_000).toISOString();
  h.session.triggerEngineTurn();
  await until(() => h.relay.reports.length === 1);

  await maybeSubmitAutoCompact(h.ctx);
  assert.deepEqual(h.relay.postedCommands, [], "not while the agent is busy");

  g.open();
  await until(() => h.relay.lastReport === false);
  await maybeSubmitAutoCompact(h.ctx);
  assert.deepEqual(h.relay.postedCommands, ["/compact"], "the idle stretch still counts once it ends");
  await h.close();
});

test("an Engine that can't Steer runs a Command arriving during its own Turn once that Turn ends", async () => {
  const g = gate();
  const causes: string[] = [];
  const h = await makeTurnHarness({
    handlerFor: (cause) => {
      causes.push(cause);
      return cause === "engine" ? workUntil(g.opened) : sayAndFinish("ran after");
    },
    script: { capabilities: { steer: false } },
  });
  h.session.triggerEngineTurn();
  await until(() => h.relay.reports.length === 1);

  const turn = runTurn(h.ctx, cmd("next, please"));
  await until(() => h.ledger.snapshot() !== undefined);
  g.open();
  await turn;

  assert.deepEqual(causes, ["engine", "command"]);
  assert.equal(indexOfText(h, "steered"), -1);
  assert.deepEqual(h.relay.reports, [true, false], "In flight throughout");
  await h.close();
});

test("on Claude, the Turn the agent starts when a Background task finishes names that task and is In flight", async () => {
  const taskNotification = {
    type: "system",
    subtype: "task_notification",
    task_id: "task-1",
    tool_use_id: "tool-1",
    status: "completed",
    summary: "done",
  } as unknown as SDKMessage;
  const { query } = scriptedQuery(
    [
      init(),
      assistantText("started it in the background"),
      taskStarted("task-1"),
      result(),
      taskNotification,
      init(),
      assistantText("the background task is done"),
      result(),
    ],
    { staysOpenAfterDrain: true },
  );
  const h = await makeTurnHarness({ engine: new ClaudeEngine({ query, env: {} }) });

  await runTurn(h.ctx, cmd("start something in the background"));
  await until(() => completes(h).length === 2);
  await until(() => h.relay.lastReport === false);

  const workingAgain = h.ctx.eventBuffer.filter((e) => e.text?.startsWith("working again"));
  assert.deepEqual(
    workingAgain.map((e) => e.text),
    ["working again: a long-running background task finished"],
  );
  assert.ok(indexOfText(h, workingAgain[0].text!) < indexOfText(h, "the background task is done"));
  assert.equal(completes(h)[1].no_notify, true);
  assert.deepEqual(h.relay.reports, [true, false, true, false]);
  await h.close();
});
