import type { EngineAnswer, EngineQuestion } from "../engine/types";
import { SessionEndedError, type CommandRecord } from "../relay/client";
import type { SessionContext } from "./context";

// How often a running turn checks whether the phone has asked it to stop.
// Bounds how long "Stop" takes to visibly do something.
export const INTERRUPT_POLL_INTERVAL_MS = 1000;

/**
 * Actions a phone's Kill against the Engine session, if one newer than the
 * last one handled is waiting. Exported and free of any interval so a test
 * can drive one check directly, exactly like {@link checkInterrupt}.
 */
export async function checkKillRequest(ctx: SessionContext): Promise<void> {
  try {
    const session = await ctx.client.getSession({ heartbeat: true });
    const kill = session.kill_task;
    if (kill && kill.requested_at !== ctx.lastHandledKillAt) {
      ctx.lastHandledKillAt = kill.requested_at;
      console.log(`Kill requested for background task ${kill.task_id}.`);
      await ctx.engineSession.killTask(kill.task_id);
    }
  } catch (e) {
    // A dead relay is the main loop's problem; a transient failure retries
    // on the next tick, exactly like the interrupt watcher.
    if (!(e instanceof SessionEndedError)) {
      console.error("Kill watcher poll failed:", (e as Error).message);
    }
  }
}

/**
 * Runs {@link checkKillRequest} for the connector's whole lifetime rather
 * than scoped to one turn -- unlike {@link watchForInterrupt}, which only
 * needs to watch while its own turn is running, a Background task can
 * outlive the turn that spawned it, so Kill must stay actionable between
 * turns too. Idempotent: killing an already-settled or unknown task is a
 * no-op.
 */
export function watchForKills(ctx: SessionContext): () => void {
  const timer = setInterval(() => {
    void checkKillRequest(ctx);
  }, INTERRUPT_POLL_INTERVAL_MS);
  return () => clearInterval(timer);
}

/**
 * Finds at most one Command to Steer the running Turn with, and only when
 * that Turn hasn't already taken one. Everything else the poll returns --
 * later Commands in the same batch, or any Command once the one Steer is
 * spent -- goes to the hand-back buffer and runs in order as ordinary Turns
 * once the current one ends.
 *
 * A no-op unless a Command's Turn is running right now, and for an Engine
 * that can't Steer at all -- a Command sent mid-Turn then simply waits for
 * the main loop to pick it up once the Turn ends. Exported and free of any
 * interval so a test can drive one check directly.
 */
export async function checkForSteer(ctx: SessionContext): Promise<void> {
  if (!ctx.engine.capabilities.steer) return;
  const held = ctx.inFlight.current();
  const turn = ctx.currentTurn;
  if (!held || !turn || !turn.running) return;
  if (turn.abortController.signal.aborted) return;
  if (ctx.questionPending) return;

  let commands: CommandRecord[];
  try {
    commands = await ctx.client.pollCommands(ctx.inFlight.cursor);
  } catch (e) {
    if (!(e instanceof SessionEndedError)) {
      console.error("Steer poll failed:", (e as Error).message);
    }
    return;
  }
  if (commands.length === 0) return;
  // Stop or a Question can have landed while that poll was in flight --
  // re-check against the same claims handle this tick started for, not
  // fresh globals. The handle is the Turn's identity, so a stale response
  // from a poll started under a Turn that has since ended can never
  // mis-claim anything.
  if (ctx.inFlight.current() !== held || turn.abortController.signal.aborted || ctx.questionPending) {
    return;
  }

  const [first, ...rest] = commands;
  if (!turn.steeredThisSubTurn && turn.running) {
    turn.steeredThisSubTurn = true;
    // Claimed and delivered with no await in between: the claim marks the
    // Steer pending synchronously, so by the time the Engine's Turn
    // boundaries reach the pump it already knows a Steer is on its way --
    // and a refusal below un-marks it before the pump can see it.
    const claiming = held.steer(first);
    let refused: unknown;
    try {
      ctx.engineSession.steer(first.text);
    } catch (e) {
      refused = e;
      held.withdrawSteer();
    }
    await claiming;
    if (refused) {
      // The Turn ended between the check above and the Steer landing, so the
      // Engine refused it. It is still a Command the human sent: run it as a
      // Turn of its own, after this one, rather than drop it.
      console.log(`A Steer arrived as its Turn ended; running it next instead: ${(refused as Error).message}`);
      ctx.handBackBuffer.push(first);
    }
  } else {
    await ctx.inFlight.hold(first, "queued");
    ctx.handBackBuffer.push(first);
  }
  for (const extra of rest) {
    await ctx.inFlight.hold(extra, "queued");
    ctx.handBackBuffer.push(extra);
  }
}

/**
 * Turn-scoped in spirit, persistent in shape -- ticking for the connector's
 * whole lifetime like {@link watchForKills}, but {@link checkForSteer} is a
 * no-op whenever no Command's Turn is running, which is most of the time
 * between Turns. Sharing one persistent timer is simpler than starting and
 * stopping a fresh one per Turn, and correctness comes from the checks
 * there, not from when the timer itself runs.
 */
export function watchForSteers(ctx: SessionContext): () => void {
  const timer = setInterval(() => {
    void checkForSteer(ctx);
  }, INTERRUPT_POLL_INTERVAL_MS);
  return () => clearInterval(timer);
}

/**
 * Aborts `controller` if the phone has asked to stop since `sinceMs`.
 *
 * Only a request newer than `sinceMs` counts, so a stop aimed at an earlier
 * turn -- or one that lands just as a turn finishes -- can never kill the
 * next one. Poll failures are ignored: the watcher retries a second later,
 * and a genuinely dead relay is the main loop's problem.
 */
export async function checkInterrupt(
  ctx: SessionContext,
  controller: AbortController,
  sinceMs: number,
): Promise<void> {
  if (controller.signal.aborted) return;
  try {
    // Doubles as the connector's liveness heartbeat: during a turn this is
    // the only relay traffic, since events flush only when there are events.
    const session = await ctx.client.getSession({ heartbeat: true });
    const at = session.interrupt_at ? Date.parse(session.interrupt_at) : 0;
    if (at > sinceMs) {
      console.log("Stop requested from the phone, aborting the current turn.");
      controller.abort();
    }
  } catch (e) {
    if (e instanceof SessionEndedError) controller.abort();
  }
}

export function watchForInterrupt(
  ctx: SessionContext,
  controller: AbortController,
  sinceMs: number,
): () => void {
  const timer = setInterval(() => {
    void checkInterrupt(ctx, controller, sinceMs);
  }, INTERRUPT_POLL_INTERVAL_MS);
  return () => clearInterval(timer);
}

/**
 * Holds one Question open until a matching Answer arrives, polling the same
 * way {@link checkInterrupt} does. Rejects once `signal` aborts (a Stop, or
 * the Engine session closing) or the session ends, which the Engine treats
 * as the Question going unanswered.
 */
function waitForAnswer(
  ctx: SessionContext,
  toolUseId: string,
  signal: AbortSignal,
): Promise<EngineAnswer> {
  return new Promise<EngineAnswer>((resolve, reject) => {
    // Checked before anything below is set up: an already-aborted signal
    // (Stop landed just as the Question did) needs no listener and no poll,
    // and finish() below assumes `timer` exists.
    if (signal.aborted) {
      reject(new Error("turn stopped"));
      return;
    }

    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(new Error("turn stopped")));
    signal.addEventListener("abort", onAbort);

    const timer = setInterval(async () => {
      try {
        const session = await ctx.client.getSession({ heartbeat: true });
        if (session.answer?.tool_use_id === toolUseId) {
          const { answers, response } = session.answer;
          finish(() => resolve({ answers, ...(response !== undefined ? { response } : {}) }));
        }
      } catch (e) {
        if (e instanceof SessionEndedError) finish(() => reject(new Error("session ended")));
        // Any other poll failure is ignored, exactly like checkInterrupt: it
        // retries a second later.
      }
    }, INTERRUPT_POLL_INTERVAL_MS);
  });
}

/**
 * The Engine's Question callback: puts the Question in front of the phone,
 * and holds the Turn until the human Answers it.
 */
export async function answerQuestion(
  ctx: SessionContext,
  question: EngineQuestion,
  signal: AbortSignal,
): Promise<EngineAnswer> {
  ctx.eventBuffer.push({
    type: "question",
    tool_use_id: question.toolUseId,
    tool_input: { questions: question.questions },
  });
  // A Turn stalled here cannot look at a Steer until this resolves --
  // watchForSteers reads this to leave the cursor alone rather than
  // advancing it over a Command nothing will read yet.
  ctx.questionPending = true;
  try {
    return await waitForAnswer(ctx, question.toolUseId, signal);
  } finally {
    ctx.questionPending = false;
  }
}
