import { DEFAULT_CONTEXT_WARNING_THRESHOLD_PERCENT } from "../config";
import { SessionEndedError, type CommandRecord, type EventInput } from "../relay/client";
import { persist } from "./commands";
import { attributionKey, measureContribution, readPosition, type Position } from "./contribution";
import type { CurrentTurn, SessionContext, TurnCause, TurnEndedEvent } from "./context";
import type { TurnClaims } from "./inFlight";
import { checkInterrupt, watchForInterrupt } from "./watchers";

/**
 * Whether this reading should fire a Context-window warning (see CONTEXT.md),
 * and what `contextWarningActive` becomes afterward. Pure and exported so the
 * edge-trigger's arm/re-arm behavior is directly testable across a sequence
 * of readings, the same way Auto-compact's `isAutoCompactDue` is (loop.ts).
 *
 * Fires only on the reading that first reaches the threshold (`!active`);
 * re-arms the moment a reading drops back below it, with no separate
 * suppression flag needed beyond the one boolean this returns.
 */
export function contextWarningCrossing(
  percentage: number,
  thresholdPercent: number,
  active: boolean,
): { fire: boolean; active: boolean } {
  if (percentage >= thresholdPercent) return { fire: !active, active: true };
  return { fire: false, active: false };
}

/**
 * Stamps a Context-window reading on `target`, and the Context-window warning
 * too when this reading is the one that crosses the configured threshold. A
 * Turn's end and a compaction are the only two moments the
 * fill level changes, so those are the only two callers.
 */
export function stampContextReading(
  ctx: SessionContext,
  target: EventInput,
  percentage: number | undefined,
): void {
  if (percentage === undefined) return;
  target.context_percentage = percentage;
  const threshold = ctx.config.contextWarningThresholdPercent ?? DEFAULT_CONTEXT_WARNING_THRESHOLD_PERCENT;
  const { fire, active } = contextWarningCrossing(percentage, threshold, ctx.contextWarningActive);
  ctx.contextWarningActive = active;
  if (fire) target.context_warning = true;
}

/**
 * Buffers the relay Events that report one Turn's end: its outcome, and its
 * Usage. Usage is reported whatever the outcome -- what a Turn cost is real
 * whether or not it finished cleanly.
 */
export function reportTurnEnded(
  ctx: SessionContext,
  event: TurnEndedEvent,
  opts: { repo: string | undefined; steered?: boolean; noNotify?: boolean },
): void {
  // Neutral wording, not "interrupted": a Steer can also land just as a Turn
  // was finishing on its own, and only "steered" is true in both cases.
  if (opts.steered) ctx.eventBuffer.push({ type: "status", text: "steered" });

  if (event.outcome === "error") {
    ctx.eventBuffer.push({
      type: "error",
      text: event.errors?.length ? event.errors.join("; ") : "the Turn failed",
      is_error: true,
    });
  } else {
    // A stopped Turn still gets its turn_complete: it is what brings the
    // phone's composer back, and a stop is a normal outcome, not a failure.
    if (event.outcome === "stopped") ctx.eventBuffer.push({ type: "status", text: "turn stopped" });
    const complete: EventInput = {
      type: "turn_complete",
      duration_ms: event.durationMs,
      ...(event.usage?.costUsd !== undefined ? { cost_usd: event.usage.costUsd } : {}),
    };
    stampContextReading(ctx, complete, event.contextPercentage);
    if (opts.noNotify) complete.no_notify = true;
    ctx.eventBuffer.push(complete);
  }

  if (event.usage) {
    const { usage } = event;
    ctx.eventBuffer.push({
      type: "usage",
      ...(usage.costUsd !== undefined ? { cost_usd: usage.costUsd } : {}),
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_creation_input_tokens: usage.cacheWriteTokens,
      cache_read_input_tokens: usage.cacheReadTokens,
      repo: opts.repo,
    });
  }
}

/**
 * One Command's Turn, and every Turn Steered into it after, as the event pump
 * hands their boundaries over. Resolves {@link done} once a Turn of the chain
 * ends with no Steer waiting to follow it.
 */
class CommandChain implements CurrentTurn {
  steeredThisSubTurn = false;
  running = false;
  private started = false;
  private finished = false;
  /**
   * Whether this chain should count as "a human showed up" for Auto-compact's
   * idle clock. True for any ordinary Command; an Auto-compact's own
   * Command does not count, but a Steer confirmed during its Turn does --
   * loop.ts never submits an Auto-compact while a Turn is in flight, so any
   * Command that reaches a Steer is phone-originated by construction. Also
   * gates the push: a routine idle Auto-compact stays silent, but the
   * human's own steered-in request must not.
   */
  private sawRealActivity: boolean;
  private resolveDone: () => void = () => undefined;
  readonly done = new Promise<void>((resolve) => {
    this.resolveDone = resolve;
  });

  constructor(
    private readonly ctx: SessionContext,
    private readonly command: CommandRecord,
    private readonly claims: TurnClaims,
    readonly abortController: AbortController,
    private readonly repo: string | undefined,
    /** How the chain's first Turn starts: its Command's own, or a Steer into a Turn the Engine started on its own. */
    private readonly firstCause: "command" | "steer",
  ) {
    this.sawRealActivity = command.source !== "auto";
    abortController.signal.addEventListener("abort", this.onAbort, { once: true });
  }

  owns(cause: TurnCause): boolean {
    if (this.finished) return false;
    if (!this.started) return cause === this.firstCause;
    return cause === "steer" && !this.running;
  }

  async onTurnStarted(cause: TurnCause): Promise<void> {
    this.started = true;
    this.running = true;
    if (cause === "steer") {
      // Checked before confirmSteer() clears the pending flag: a confirmed
      // Steer is always phone-originated (see sawRealActivity).
      if (this.claims.pendingSteerSeq) this.sawRealActivity = true;
      await this.claims.confirmSteer();
    }
    // Each Turn gets its own allowance to be Steered again -- a steered
    // exchange is a conversation, not a single correction.
    this.steeredThisSubTurn = false;
  }

  async onTurnEnded(event: TurnEndedEvent): Promise<void> {
    this.running = false;
    const stopped = event.outcome === "stopped" || this.abortController.signal.aborted;
    // Read before settling: a Steer claimed and delivered while this Turn ran
    // is waiting to start as the next one. Both the "steered" marker and the
    // no-push flag reflect that same fact.
    const steered = !stopped && !!this.claims.pendingSteerSeq;
    // Settling this one doesn't make the relay-facing fact flicker false
    // before the Steer's own Turn starts: the Steer's claim is already held.
    await this.claims.settleActive();
    // Auto-compact's idle stretch starts here, at the moment the human got
    // their answer -- not once any Background work the Turn left running
    // finishes, which may be never.
    if (!stopped && this.sawRealActivity) {
      persist(this.ctx, { lastRealTurnCompletedAt: new Date().toISOString() });
    }
    if (stopped) console.log("Turn stopped.");
    reportTurnEnded(this.ctx, event, {
      repo: this.repo,
      steered,
      // Skipped when this Turn took a Steer (the human already knows work
      // didn't finish quietly), and for an Auto-compact's own routine Turn --
      // but not for a real Command steered into a running Auto-compact, whose
      // own outcome the human is still owed a buzz for.
      noNotify: steered || (this.command.source === "auto" && !this.sawRealActivity),
    });
    if (!steered) this.finish();
  }

  onOtherTurnStarted(): void {
    // A chain Steered into the Engine's own Turn is, before it starts,
    // waiting on a Steer just like one between two of its own Turns.
    if (!this.running && (this.started || this.firstCause === "steer")) this.finish();
  }

  release(): void {
    this.finish();
  }

  /**
   * True once a Stop has discarded the Steer this chain began with, into a
   * Turn the Engine started on its own, before that Steer's Turn began.
   */
  get steerDiscarded(): boolean {
    return this.firstCause === "steer" && !this.started && this.abortController.signal.aborted;
  }

  private readonly onAbort = (): void => {
    this.ctx.engineSession.stop();
    // Waiting between a Turn and the Steer's own: the Stop discards that
    // Steer (duringTurn drops it), so there is nothing left to wait for. A
    // Turn still running, or not yet started, is left to the Engine, which
    // reports it ended as stopped.
    if (this.started && !this.running && !this.finished) {
      this.ctx.eventBuffer.push({ type: "status", text: "turn stopped" });
      this.finish();
    }
    // Waiting on a Steer into the Engine's own Turn: the Stop discards it the
    // same way, and that Turn reports its own stop.
    if (this.steerDiscarded) this.finish();
  };

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.abortController.signal.removeEventListener("abort", this.onAbort);
    this.resolveDone();
  }
}

/**
 * Runs a Command's Turn to completion -- which, once a Steer lands, is really
 * a chain of Turns: the Engine ends the one the Steer cut short and starts the
 * Steer's own, and this keeps going, promoting whichever Command that Turn
 * belongs to, until a Turn ends having taken no further Steer.
 *
 * Returns once that last Turn has ended, not once the Engine's Background
 * work has drained: a Background task can run for as long as it likes (a dev
 * server may never stop) and must not hold the next Command hostage.
 *
 * The whole body runs inside the in-flight scope, which sweeps whatever
 * claims are still held however this function exits. Nothing below unwinds a
 * claim by hand.
 */
export async function runTurn(ctx: SessionContext, command: CommandRecord): Promise<void> {
  const abortController = new AbortController();

  // Read before any of the Turn's work starts, so the range below spans
  // everything it committed -- including a Steer's Turns, which are part of
  // the same piece of work.
  const positionBefore = await readPosition(ctx.config.projectDir);
  // Read once and reused on every usage Event this chain posts -- the working
  // directory's remote does not change mid-Turn.
  const repo = await attributionKey(ctx.config.projectDir);

  await ctx.inFlight.duringTurn(command, abortController.signal, async (claims) => {
    // A stop counts if it was issued after the command it targets -- not after
    // the turn started. Turns run one at a time, so a command can sit queued
    // for minutes; stopping during that wait must still cancel it, and both
    // timestamps come from the relay, so the comparison needs no clock sync.
    const chainStartedAt = Date.now();
    const sinceMs = Date.parse(command.created_at) || chainStartedAt;
    const stopWatching = watchForInterrupt(ctx, abortController, sinceMs);
    try {
      await checkInterrupt(ctx, abortController, sinceMs);
      if (abortController.signal.aborted) {
        console.log("Turn stopped before it started.");
        ctx.eventBuffer.push(
          { type: "status", text: "turn stopped" },
          { type: "turn_complete", duration_ms: Date.now() - chainStartedAt },
        );
        return;
      }
      // A Command arriving while the Engine works on its own Steers that
      // Turn, just as it would Steer a Command's. No await between the Steer
      // and the chain taking over: the pump must find the chain in place
      // before the Steer's own Turn can start.
      const firstCause = ctx.engineTurn?.steer(command.text) ? "steer" : "command";
      const chain = new CommandChain(ctx, command, claims, abortController, repo, firstCause);
      ctx.currentTurn = chain;
      if (firstCause === "command") ctx.engineSession.send(command.text);
      await chain.done;
      // Discarded visibly, as a pending Steer always is under Stop: the
      // brake starting fresh work is not a brake.
      if (chain.steerDiscarded) await ctx.inFlight.drop(command.seq);
    } finally {
      stopWatching();
      ctx.currentTurn = undefined;
    }
  });

  await reportContribution(ctx, positionBefore);
}

/**
 * Tells the relay what this Turn committed, if anything. Runs after the
 * in-flight scope has closed, so a slow git or a slow relay cannot hold the
 * phone's brake on past the work it describes.
 *
 * Best-effort in every direction: a Turn that committed nothing reports
 * nothing, and a report that fails is dropped rather than retried or
 * remembered. A Turn stopped part-way still reports -- the commits it made
 * before the brake are as real as any others.
 */
async function reportContribution(
  ctx: SessionContext,
  positionBefore: Position | undefined,
): Promise<void> {
  try {
    const contribution = await measureContribution(ctx.config.projectDir, positionBefore);
    if (!contribution) return;
    await ctx.client.postContribution(contribution);
  } catch (e) {
    if (e instanceof SessionEndedError) return;
    console.error("Failed to report contribution:", (e as Error).message);
  }
}
