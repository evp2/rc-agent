import type { EngineEvent } from "../engine/types";
import type { SessionContext, TurnEndedEvent } from "./context";
import { attributionKey } from "./contribution";
import { reportTurnEnded } from "./turn";
import { watchForInterrupt } from "./watchers";
import { deliverWithWithdrawnNote } from "./withdrawn";

type TaskStarted = Extract<EngineEvent, { type: "task_started" }>;
type TaskSettled = Extract<EngineEvent, { type: "task_settled" }>;

/**
 * Remembers which Background tasks finished since the last Turn started --
 * the likeliest reason the Engine picked the Conversation back up unprompted.
 */
export class WakeCauses {
  private readonly descriptions = new Map<string, string | undefined>();
  private settledSinceLastTurn: (string | undefined)[] = [];

  noteStarted(event: TaskStarted): void {
    this.descriptions.set(event.taskId, event.description);
  }

  noteSettled(event: TaskSettled): void {
    this.settledSinceLastTurn.push(this.descriptions.get(event.taskId));
    this.descriptions.delete(event.taskId);
  }

  /**
   * The status line said before an Engine-started Turn, and a fresh start
   * for the next one. Called at every Turn's start, not only the Engine's
   * own: a task that finished before a Command's Turn was that Turn's news,
   * not the cause of some later one.
   */
  take(): string {
    const settled = this.settledSinceLastTurn;
    this.settledSinceLastTurn = [];
    if (!settled.length) return "turn started";
    const named = settled.filter((d): d is string => !!d);
    return named.length ? `turn started: ${named.join(", ")} finished` : "turn started: a background task finished";
  }
}

/**
 * A Turn the Engine started on its own, while it runs: nobody's Command, but
 * In flight all the same, so the phone offers the brake.
 */
export class EngineStartedTurn {
  /** Whether a Command has been Steered into this Turn -- at most one, as for any Turn. */
  private steered = false;
  /** Aborted by the brake, which stops the Engine's Turn. */
  readonly abortController = new AbortController();
  private readonly stopWatching: () => void;

  private constructor(private readonly ctx: SessionContext) {
    this.abortController.signal.addEventListener("abort", () => ctx.engineSession.stop(), { once: true });
    // Only a Stop tapped after this Turn began counts. The Turn has no
    // Command to carry a relay timestamp, so this is the local clock's --
    // close enough for a brake the phone only offers once it sees the Turn.
    this.stopWatching = watchForInterrupt(ctx, this.abortController, Date.now());
  }

  /** Says why the agent is working again, and counts the Turn as In flight. */
  static async begin(ctx: SessionContext, wakeCause: string): Promise<EngineStartedTurn> {
    const turn = new EngineStartedTurn(ctx);
    ctx.engineTurn = turn;
    ctx.eventBuffer.push({ type: "status", text: wakeCause });
    await ctx.inFlight.holdEngineTurn();
    return turn;
  }

  /**
   * Streams a Command into this Turn, under the ordinary Steer rules: one per
   * Turn, none while a Question is pending, and only on an Engine that can
   * Steer. Returns whether it landed; when it didn't, the Command runs as a
   * Turn of its own instead.
   */
  steer(text: string): boolean {
    if (this.steered || this.abortController.signal.aborted) return false;
    if (!this.ctx.engine.capabilities.steer || this.ctx.questionPending) return false;
    try {
      deliverWithWithdrawnNote(this.ctx, text, (noted) => this.ctx.engineSession.steer(noted));
    } catch {
      // The Turn ended just now: nothing left to Steer.
      return false;
    }
    this.steered = true;
    return true;
  }

  /**
   * Reports the Turn's outcome. Never a push -- a buzz means work the human
   * asked for is done -- and never Auto-compact's idle clock, since nobody
   * showed up.
   */
  async end(event: TurnEndedEvent): Promise<void> {
    this.stopWatching();
    if (this.ctx.engineTurn === this) this.ctx.engineTurn = undefined;
    reportTurnEnded(this.ctx, event, {
      repo: await attributionKey(this.ctx.config.projectDir),
      steered: this.steered && event.outcome !== "stopped",
      noNotify: true,
    });
    await this.ctx.inFlight.releaseEngineTurn();
  }
}
