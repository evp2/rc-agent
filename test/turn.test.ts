import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ClaudeEngine } from "../src/engine/claude/adapter.ts";
import {
  askAndFinish,
  hangUntilStopped,
  sayAndFinish,
  startBackgroundTaskAndFinish,
  type FakeTurnHandler,
} from "../src/engine/fakeEngine.ts";
import type { EngineUsage } from "../src/engine/types.ts";
import type { CommandRecord } from "../src/relay/client.ts";
import { contextWarningCrossing, runTurn } from "../src/session/turn.ts";
import { checkForSteer } from "../src/session/watchers.ts";
import { assistantText, init, result, scriptedQuery, taskStarted } from "./claudeDoubles.ts";
import { cmd, makeTurnHarness, until, type TurnHarness } from "./doubles.ts";

const types = (h: TurnHarness) => h.ctx.eventBuffer.map((e) => e.type);
const statuses = (h: TurnHarness) => h.ctx.eventBuffer.filter((e) => e.type === "status").map((e) => e.text);
const completes = (h: TurnHarness) => h.ctx.eventBuffer.filter((e) => e.type === "turn_complete");

/** A sentinel `race` resolves to when `promise` hasn't settled within `ms`. */
const TIMED_OUT = Symbol("timed out");
async function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), ms));
  return Promise.race([promise, timeout]);
}

/** A Turn that says one line and ends, reporting `outcome` extras such as Usage or a context reading. */
function sayAndReport(
  text: string,
  extra: { usage?: EngineUsage; contextPercentage?: number; outcome?: "success" | "error"; errors?: string[] } = {},
): FakeTurnHandler {
  return async (ctx) => {
    ctx.emit({ type: "assistant_text", text });
    return { outcome: "success", ...extra };
  };
}

/** A Turn that works until something cuts it short -- a Steer or a Stop -- and then says nothing more, as a real truncated Turn doesn't. */
const workUntilInterrupted: FakeTurnHandler = async (ctx) => {
  ctx.emit({ type: "assistant_text", text: "working" });
  await ctx.waitForInterruption();
  return ctx.stopped ? { outcome: "stopped" } : { outcome: "success" };
};

/** The relay hands `commands` to the next Steer poll, and nothing after that. */
function queueForSteerPoll(h: TurnHarness, commands: CommandRecord[]): void {
  let served = false;
  h.relay.pollCommands = async () => {
    if (served) return [];
    served = true;
    return commands;
  };
}

/**
 * Starts `command`'s Turn and waits until it is genuinely running -- the only
 * time a Steer can land. The Turn itself comes back wrapped: returned bare
 * from an async function, it would be awaited right here.
 */
async function startTurn(h: TurnHarness, command: CommandRecord): Promise<{ turn: Promise<void> }> {
  const turn = runTurn(h.ctx, command);
  await until(() => !!h.ctx.currentTurn?.running);
  return { turn };
}

test("an ordinary Turn holds nothing at the end", async () => {
  const h = await makeTurnHarness({ handlerFor: () => sayAndFinish("hello") });

  await runTurn(h.ctx, cmd("say hello"));

  assert.equal(h.ledger.snapshot(), undefined);
  assert.equal(h.ledger.current(), undefined);
  assert.equal(h.ctx.currentTurn, undefined);
  assert.deepEqual(h.relay.reports, [true, false]);
  assert.ok(types(h).includes("assistant_text"));
  assert.ok(types(h).includes("turn_complete"));
  await h.close();
});

// A regression pinned against the Claude adapter: a real Claude
// query stays open for as long as its input is open, which outlasts a Turn's
// own `result` while a Background task it started keeps running. Waiting for
// the query to drain left the main loop stuck until someone tapped Stop.
test("a Claude Turn that starts a Background task hands the main loop back once its own result lands, without needing a Stop", async () => {
  const { query } = scriptedQuery([init(), assistantText("starting a background task"), taskStarted(), result()], {
    staysOpenAfterDrain: true,
  });
  const h = await makeTurnHarness({ engine: new ClaudeEngine({ query, env: {} }) });

  const outcome = await raceWithTimeout(runTurn(h.ctx, cmd("kick off a background task")), 1000);

  assert.notEqual(
    outcome,
    TIMED_OUT,
    "the Turn's own result already landed; a still-running Background task must not hold the main loop hostage",
  );
  assert.equal(h.ledger.snapshot(), undefined);
  await h.close();
});

test("a Command sent while a Background task is still running starts once the previous Turn has ended", async () => {
  const neverSettles = new Promise<void>(() => undefined);
  const h = await makeTurnHarness({
    handlerFor: (_cause, text) =>
      text === "start a dev server"
        ? startBackgroundTaskAndFinish("dev-server", neverSettles, { description: "npm run dev" })
        : sayAndFinish("the second Command ran"),
  });

  await runTurn(h.ctx, cmd("start a dev server"));
  const second = await raceWithTimeout(runTurn(h.ctx, cmd("now something else")), 1000);

  assert.notEqual(second, TIMED_OUT);
  assert.ok(h.ctx.eventBuffer.some((e) => e.text === "the second Command ran"));
  assert.deepEqual(h.ctx.runningTasks.map((t) => t.task_id), ["dev-server"], "the Background task is still running");
  await h.close();
});

test("a Steer ends the running Turn, marked steered and silent, and its own Turn becomes the active Command", async () => {
  const h = await makeTurnHarness({
    handlerFor: (cause, text) => (cause === "steer" ? sayAndFinish(`steered: ${text}`) : workUntilInterrupted),
  });
  const steer = cmd("a correction");
  queueForSteerPoll(h, [steer]);

  const { turn } = await startTurn(h, cmd("first"));
  await checkForSteer(h.ctx);
  await turn;

  assert.equal(h.ledger.snapshot(), undefined, "both Commands settled");
  // Never flickers false between the truncated Turn and the steered one: the
  // Steer was already held when the first Turn settled.
  assert.deepEqual(h.relay.reports, [true, false]);
  const [truncated, steered] = completes(h);
  assert.equal(truncated.no_notify, true, "a buzz for a Turn the human cut short would be a lie");
  assert.notEqual(steered.no_notify, true, "the steered Turn's own outcome still buzzes");
  assert.ok(statuses(h).includes("steered"), "neutral wording, not 'interrupted'");
  assert.ok(h.ctx.eventBuffer.some((e) => e.text === "steered: a correction"));
  await h.close();
});

test("a steered Turn can be Steered again", async () => {
  let steerTurns = 0;
  const h = await makeTurnHarness({
    handlerFor: (cause) => {
      if (cause !== "steer") return workUntilInterrupted;
      steerTurns += 1;
      return steerTurns === 1 ? workUntilInterrupted : sayAndFinish("done");
    },
  });

  const { turn } = await startTurn(h, cmd("first"));
  queueForSteerPoll(h, [cmd("first correction")]);
  await checkForSteer(h.ctx);
  await until(() => h.ctx.currentTurn?.running === true && h.ctx.currentTurn.steeredThisSubTurn === false);
  queueForSteerPoll(h, [cmd("second correction")]);
  await checkForSteer(h.ctx);
  await turn;

  assert.equal(completes(h).length, 3);
  assert.equal(h.ledger.snapshot(), undefined);
  assert.deepEqual(h.relay.reports, [true, false]);
  await h.close();
});

test("only one Steer per Turn: the rest of the poll is handed back to run afterwards, in order", async () => {
  const h = await makeTurnHarness({
    handlerFor: (cause) => (cause === "steer" ? sayAndFinish("steered") : workUntilInterrupted),
  });
  const steer = cmd("steer A");
  const later = cmd("later B");
  queueForSteerPoll(h, [steer, later]);

  const { turn } = await startTurn(h, cmd("first"));
  await checkForSteer(h.ctx);
  await turn;

  assert.deepEqual(h.ctx.handBackBuffer, [later]);
  assert.deepEqual(h.ledger.snapshot(), [{ seq: later.seq, text: later.text, status: "queued" }]);
  await h.close();
});

test("a Steer the Engine refuses, because its Turn had just ended, runs next instead of being dropped", async () => {
  const h = await makeTurnHarness({ handlerFor: () => workUntilInterrupted });
  const late = cmd("arrived just as the Turn ended");
  queueForSteerPoll(h, [late]);
  const { turn } = await startTurn(h, cmd("first"));
  const refusing = h.ctx.engineSession;
  (h.ctx as { engineSession: typeof refusing }).engineSession = {
    ...refusing,
    events: refusing.events,
    send: (text) => refusing.send(text),
    stop: () => refusing.stop(),
    killTask: (id) => refusing.killTask(id),
    close: () => refusing.close(),
    steer: () => {
      throw new Error("no running Turn to Steer");
    },
  };

  await checkForSteer(h.ctx);
  h.ctx.currentTurn!.abortController.abort();
  await turn;

  assert.deepEqual(h.ctx.handBackBuffer, [late]);
  assert.deepEqual(h.ledger.snapshot(), [{ seq: late.seq, text: late.text, status: "queued" }]);
  assert.ok(!types(h).includes("command_discarded"), "nothing the human typed is dropped");
  await h.close();
});

test("a Stop mid-Turn ends it, says so, and releases the claim", async () => {
  const h = await makeTurnHarness({ handlerFor: () => hangUntilStopped() });

  const { turn } = await startTurn(h, cmd("keep going"));
  h.ctx.currentTurn!.abortController.abort();
  await turn;

  assert.equal(h.ledger.snapshot(), undefined);
  assert.deepEqual(h.relay.reports, [true, false]);
  assert.ok(statuses(h).includes("turn stopped"));
  assert.equal(completes(h).length, 1, "the composer comes back");
  assert.equal(h.ctx.state.lastRealTurnCompletedAt, undefined, "a stopped Turn gave the human no answer to idle after");
  await h.close();
});

test("a Stop before the Turn starts settles the claim and still completes the Turn", async () => {
  let started = false;
  const h = await makeTurnHarness({
    handlerFor: () => {
      started = true;
      return sayAndFinish("should not run");
    },
  });
  // interrupt_at newer than the Command is what checkInterrupt acts on.
  h.relay.getSession = async () => ({ interrupt_at: new Date(Date.now() + 60_000).toISOString() });

  await runTurn(h.ctx, cmd("too late"));

  assert.equal(started, false, "the Command never reached the Engine");
  assert.equal(h.ledger.snapshot(), undefined, "the claim is not left behind");
  assert.equal(h.relay.lastReport, false);
  assert.ok(statuses(h).includes("turn stopped"));
  assert.ok(types(h).includes("turn_complete"), "the composer comes back even though nothing ran");
  await h.close();
});

test("a Stop landing after a Steer is claimed but before its Turn starts discards it, and says so", async () => {
  let steerTurnRan = false;
  const h = await makeTurnHarness({
    handlerFor: (cause) => {
      if (cause === "steer") steerTurnRan = true;
      return cause === "steer" ? sayAndFinish("steered") : workUntilInterrupted;
    },
    script: {
      beforeSteerConfirm: async (ctx) => {
        h.ctx.currentTurn!.abortController.abort();
        await ctx.waitForStop();
      },
    },
  });
  queueForSteerPoll(h, [cmd("a steer landing right before Stop")]);

  const { turn } = await startTurn(h, cmd("first"));
  await checkForSteer(h.ctx);
  await turn;

  assert.equal(steerTurnRan, false, "the brake starting fresh work is not a brake");
  const discarded = h.ctx.eventBuffer.find((e) => e.type === "command_discarded");
  assert.equal(discarded?.text, "a steer landing right before Stop");
  assert.equal(h.ledger.snapshot(), undefined);
  assert.equal(h.relay.lastReport, false);
  await h.close();
});

test("a Question is put in front of the phone, and its Answer continues the Turn", async () => {
  const h = await makeTurnHarness({
    handlerFor: () =>
      askAndFinish({
        toolUseId: "toolu_q1",
        questions: [{ question: "Which approach?", options: [{ label: "A" }, { label: "B" }], multiSelect: false }],
      }),
  });
  h.relay.getSession = async () => ({ answer: { tool_use_id: "toolu_q1", answers: { "Which approach?": "A" } } });

  await runTurn(h.ctx, cmd("ask me something"));

  const question = h.ctx.eventBuffer.find((e) => e.type === "question");
  assert.equal(question?.tool_use_id, "toolu_q1");
  assert.deepEqual((question?.tool_input as { questions: unknown[] }).questions.length, 1);
  assert.ok(h.ctx.eventBuffer.some((e) => e.text === 'answered: {"Which approach?":"A"}'));
  assert.equal(h.ctx.questionPending, false);
  await h.close();
});

test("no Steer is taken while a Question is pending", async () => {
  const h = await makeTurnHarness({
    handlerFor: () => askAndFinish({ toolUseId: "toolu_q1", questions: [] }),
  });
  let polled = false;
  h.relay.pollCommands = async () => {
    polled = true;
    return [cmd("sent during the Question")];
  };

  const turn = runTurn(h.ctx, cmd("ask me something"));
  await until(() => h.ctx.questionPending);
  await checkForSteer(h.ctx);

  assert.equal(polled, false, "the cursor is left alone over a Command the stalled Turn cannot read");
  h.ctx.currentTurn!.abortController.abort();
  await turn;
  await h.close();
});

test("a Stop tapped while a Question is pending ends the Turn cleanly", async () => {
  const h = await makeTurnHarness({ handlerFor: () => askAndFinish({ toolUseId: "toolu_q1", questions: [] }) });

  const turn = runTurn(h.ctx, cmd("ask me something"));
  await until(() => h.ctx.questionPending);
  h.ctx.currentTurn!.abortController.abort();
  await turn;

  assert.equal(h.ctx.questionPending, false);
  assert.ok(statuses(h).includes("turn stopped"));
  assert.equal(h.ctx.eventBuffer.some((e) => e.is_error), false, "a Stop is not a failure");
  assert.equal(h.ledger.snapshot(), undefined);
  await h.close();
});

test("a real Command's Turn completing records lastRealTurnCompletedAt", async () => {
  const h = await makeTurnHarness();

  await runTurn(h.ctx, cmd("say hello"));

  assert.ok(h.ctx.state.lastRealTurnCompletedAt, "Auto-compact's idle clock needs this to be set");
  await h.close();
});

test("an Auto-compact Command's Turn does not move lastRealTurnCompletedAt, and skips the push", async () => {
  const h = await makeTurnHarness({ handlerFor: () => sayAndFinish("compacted") });

  await runTurn(h.ctx, cmd("/compact", undefined, "auto"));

  assert.equal(
    h.ctx.state.lastRealTurnCompletedAt,
    undefined,
    "an Auto-compact firing must not re-arm itself, or it would repeat forever",
  );
  assert.equal(completes(h)[0]?.no_notify, true, "a routine idle compact is not worth a phone buzz");
  await h.close();
});

test("a real Command steered into a running Auto-compact still counts as real activity", async () => {
  // loop.ts never submits Auto-compact while a Turn is in flight, so any
  // Command that reaches a Steer is, by construction, phone-originated --
  // confirming one is exactly the "a human showed up" signal that should
  // re-arm Auto-compact's idle clock, even though the Turn it steered *into*
  // was itself the Auto-compact.
  const h = await makeTurnHarness({
    handlerFor: (cause) => (cause === "steer" ? sayAndFinish("hi") : workUntilInterrupted),
  });
  queueForSteerPoll(h, [cmd("a real message")]);

  const { turn } = await startTurn(h, cmd("/compact", undefined, "auto"));
  await checkForSteer(h.ctx);
  await turn;

  assert.ok(h.ctx.state.lastRealTurnCompletedAt, "the steered-in real Command should re-arm the idle clock");
  const [compact, reply] = completes(h);
  assert.equal(compact.no_notify, true, "Auto-compact's own Turn stays silent");
  assert.notEqual(reply.no_notify, true, "the human's own steered-in reply must still buzz");
  await h.close();
});

test("a Context-window warning fires once when the percentage crosses the default threshold", async () => {
  const h = await makeTurnHarness({ handlerFor: () => sayAndReport("hello", { contextPercentage: 75 }) });

  await runTurn(h.ctx, cmd("say hello"));

  const [complete] = completes(h);
  assert.equal(complete.context_percentage, 75);
  assert.equal(complete.context_warning, true);
  assert.equal(h.ctx.contextWarningActive, true);
  await h.close();
});

test("a Context-window reading below the default threshold stays silent", async () => {
  const h = await makeTurnHarness({ handlerFor: () => sayAndReport("hello", { contextPercentage: 50 }) });

  await runTurn(h.ctx, cmd("say hello"));

  assert.equal(completes(h)[0].context_warning, undefined);
  assert.equal(h.ctx.contextWarningActive, false);
  await h.close();
});

test("contextWarningCrossing fires only on the Turn that first reaches the threshold", () => {
  const first = contextWarningCrossing(75, 70, false);
  assert.deepEqual(first, { fire: true, active: true });

  const second = contextWarningCrossing(80, 70, first.active);
  assert.deepEqual(second, { fire: false, active: true }, "stays silent while still over threshold");
});

test("contextWarningCrossing re-arms once the percentage drops back below threshold", () => {
  const crossed = contextWarningCrossing(75, 70, false);
  const dropped = contextWarningCrossing(50, 70, crossed.active);
  assert.deepEqual(dropped, { fire: false, active: false });

  const recrossed = contextWarningCrossing(80, 70, dropped.active);
  assert.deepEqual(recrossed, { fire: true, active: true }, "fires again on the second crossing");
});

test("a configured Context-window warning threshold overrides the default", async () => {
  const h = await makeTurnHarness({
    handlerFor: () => sayAndReport("hello", { contextPercentage: 60 }),
    config: { contextWarningThresholdPercent: 55 },
  });

  await runTurn(h.ctx, cmd("say hello"));

  assert.equal(completes(h)[0].context_warning, true, "60% crosses the configured 55% threshold");
  await h.close();
});

test("a Context-window overflow fires when the Engine compacts on its own, independently of the warning tier", async () => {
  const h = await makeTurnHarness({
    handlerFor: () => async (ctx) => {
      ctx.emit({ type: "compacting", trigger: "auto" });
      ctx.emit({ type: "compacted", preTokens: 1000, postTokens: 200, contextPercentage: 80 });
      return { outcome: "success" };
    },
  });

  await runTurn(h.ctx, cmd("first"));

  const overflow = h.ctx.eventBuffer.find((e) => e.context_overflow === true);
  assert.equal(overflow?.type, "status", "an unplanned compaction produces a context_overflow status event");
  const compacted = h.ctx.eventBuffer.find((e) => e.text === "compacted (1000 → 200 tokens)");
  assert.equal(compacted?.context_percentage, 80, "the compaction carries the reading taken after it");
  assert.equal(compacted?.context_warning, true, "the same reading still independently crosses the warning threshold");
  await h.close();
});

test("a Context-window overflow does not fire for a manual compaction", async () => {
  const h = await makeTurnHarness({
    handlerFor: () => async (ctx) => {
      ctx.emit({ type: "compacting", trigger: "manual" });
      return { outcome: "success" };
    },
  });

  await runTurn(h.ctx, cmd("/compact"));

  assert.equal(h.ctx.eventBuffer.find((e) => e.context_overflow === true), undefined);
  await h.close();
});

test("a failed Turn leaves nothing held and says why", async () => {
  const h = await makeTurnHarness({ handlerFor: () => async () => ({ outcome: "error", errors: ["subprocess exited"] }) });

  await runTurn(h.ctx, cmd("first"));

  assert.equal(h.ledger.snapshot(), undefined);
  assert.equal(h.relay.lastReport, false);
  const errors = h.ctx.eventBuffer.filter((e) => e.is_error).map((e) => e.text);
  assert.deepEqual(errors, ["subprocess exited"]);
  await h.close();
});

test("a successful Turn posts a usage event with its cost and token counts", async () => {
  const h = await makeTurnHarness({
    handlerFor: () =>
      sayAndReport("hello", {
        usage: { inputTokens: 1000, outputTokens: 200, cacheWriteTokens: 30, cacheReadTokens: 15, costUsd: 0.042 },
      }),
  });

  await runTurn(h.ctx, cmd("say hello"));

  const usage = h.ctx.eventBuffer.filter((e) => e.type === "usage");
  assert.deepEqual(usage, [
    {
      type: "usage",
      cost_usd: 0.042,
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 15,
      repo: undefined,
    },
  ]);
  assert.equal(completes(h)[0].cost_usd, 0.042);
  await h.close();
});

test("Usage with no dollar cost posts its tokens and leaves the cost out", async () => {
  const h = await makeTurnHarness({
    handlerFor: () =>
      sayAndReport("hello", { usage: { inputTokens: 10, outputTokens: 2, cacheWriteTokens: 0, cacheReadTokens: 0 } }),
  });

  await runTurn(h.ctx, cmd("say hello"));

  const usage = h.ctx.eventBuffer.find((e) => e.type === "usage");
  assert.ok(usage && !("cost_usd" in usage), "no dollar figure is made up");
  assert.ok(!("cost_usd" in completes(h)[0]));
  await h.close();
});

test("an errored Turn still posts a usage event -- usage isn't lost just because the Turn failed", async () => {
  const h = await makeTurnHarness({
    handlerFor: () => async () => ({
      outcome: "error",
      errors: ["failed"],
      usage: { inputTokens: 500, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0.01 },
    }),
  });

  await runTurn(h.ctx, cmd("do something risky"));

  const usage = h.ctx.eventBuffer.filter((e) => e.type === "usage");
  assert.equal(usage.length, 1);
  assert.equal(usage[0].cost_usd, 0.01);
  assert.equal(usage[0].input_tokens, 500);
  await h.close();
});

test("a Turn claimed from the hand-back buffer is promoted, not re-claimed", async () => {
  const h = await makeTurnHarness();
  const queued = cmd("queued work");
  await h.ledger.hold(queued, "queued");

  await runTurn(h.ctx, queued);

  assert.equal(h.ledger.snapshot(), undefined);
  assert.equal(h.ledger.cursor, queued.seq, "the cursor did not advance twice");
  assert.deepEqual(h.relay.reports, [true, false]);
  await h.close();
});

/** A repository the Turn below can commit into, so the report is measured from real history. */
function makeRepo(origin?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "crc-turn-repo-"));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.invalid");
  run("config", "user.name", "Test");
  if (origin) run("remote", "add", "origin", origin);
  writeFileSync(join(dir, "README.md"), "start\n");
  run("add", "-A");
  run("commit", "-q", "-m", "initial");
  return dir;
}

const USAGE: EngineUsage = { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0.001 };

test("a Turn that committed reports it once, attributed to the repo", async () => {
  const dir = makeRepo("git@github.com:acme/widgets.git");
  const h = await makeTurnHarness({
    projectDir: dir,
    handlerFor: () => async (ctx) => {
      writeFileSync(join(dir, "feature.ts"), "one\ntwo\n");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "feature"], { cwd: dir });
      ctx.emit({ type: "assistant_text", text: "committed" });
      return { outcome: "success" };
    },
  });

  await runTurn(h.ctx, cmd("build the feature"));

  assert.deepEqual(h.relay.contributions, [{ host: "github.com", repo: "acme/widgets", added: 2, deleted: 0 }]);
  await h.close();
});

test("a Turn that committed nothing reports nothing, but still posts usage attributed to the repo", async () => {
  const dir = makeRepo("git@github.com:acme/widgets.git");
  const h = await makeTurnHarness({ projectDir: dir, handlerFor: () => sayAndReport("just talking", { usage: USAGE }) });

  await runTurn(h.ctx, cmd("what does this do?"));

  assert.deepEqual(h.relay.contributions, [], "nothing was committed");
  const usage = h.ctx.eventBuffer.find((e) => e.type === "usage");
  assert.equal(usage?.repo, "github.com#acme/widgets", "same attribution Contributions uses");
  await h.close();
});
