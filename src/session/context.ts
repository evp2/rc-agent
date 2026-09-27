import type { ConnectorConfig } from "../config";
import type { Engine, EngineEvent, EngineSession } from "../engine/types";
import type { CommandRecord, EventInput, RelayClient } from "../relay/client";
import type { createBannerDeduper } from "./engineEvents";
import type { EngineStartedTurn } from "./engineTurn";
import type { InFlight } from "./inFlight";
import type { ConnectorState } from "../state";

/** What a Fork attempt resolves to on success -- see {@link SessionContext.executeFork}. */
export interface ForkOutcome {
  controlUrl: string | undefined;
}

/**
 * The Command Turn chain currently executing, if any -- a Command's own Turn
 * plus any Turns Steered into it. Shared between {@link runTurn} in turn.ts,
 * the event pump in pump.ts (which hands it the Turn boundaries it owns) and
 * {@link watchForSteers} in watchers.ts.
 *
 * Carries only what is not a claim. Which Commands the chain holds, and which
 * of them a Steer is waiting on, live on the handle {@link InFlight.current}
 * returns: they used to be duplicated here and in the held set, and the two
 * copies drifting is what left a Steer claimed forever.
 */
export interface CurrentTurn {
  abortController: AbortController;
  /** Whether the chain's Turn running right now has already taken its one allowed Steer. */
  steeredThisSubTurn: boolean;
  /** True between one of this chain's `turn_started` and its `turn_ended` -- the only time a Steer is legal. */
  readonly running: boolean;
  /** Whether a Turn starting with `cause` is this chain's: its Command's own, or the Steer it is waiting on. */
  owns(cause: TurnCause): boolean;
  onTurnStarted(cause: TurnCause): Promise<void>;
  onTurnEnded(event: TurnEndedEvent): Promise<void>;
  /**
   * Some other Turn started. If the chain was waiting on a Steer's own Turn,
   * that Steer is not coming, so the chain ends here rather than wait forever.
   */
  onOtherTurnStarted(): void;
  /** Ends the chain without waiting on another Turn boundary -- the Engine's event stream is over. */
  release(): void;
}

export type TurnCause = Extract<EngineEvent, { type: "turn_started" }>["cause"];
export type TurnEndedEvent = Extract<EngineEvent, { type: "turn_ended" }>;

/**
 * The mutable state shared by every module under `session/`, plus the
 * connection's fixed dependencies. One instance per `runConnector` call,
 * built in loop.ts and threaded through commands.ts/events.ts/watchers.ts/
 * turn.ts explicitly instead of via closures, since those modules each own a
 * different slice of the same session lifecycle.
 */
export interface SessionContext {
  readonly client: RelayClient;
  readonly config: ConnectorConfig;
  /** What the session knows about the Engine it drives, beyond the open session itself. */
  readonly engine: Pick<Engine, "kind" | "capabilities">;
  /** The one Engine session this connector drives for its whole life. */
  readonly engineSession: EngineSession;
  /** Turns an Engine's `announce` into the session banner, deduplicated across Turns. */
  readonly bannerFor: ReturnType<typeof createBannerDeduper>;

  /** How durable state reaches disk. A field rather than a direct import because the real one resolves a path under the user's home directory, which a test must not write to. */
  readonly writeState: (state: ConnectorState) => void;

  /** The authoritative record of every Command held but not finished, and the command-log cursor that moves with it. */
  readonly inFlight: InFlight;

  state: ConnectorState;
  /** Last-published skill+local-command lists, as JSON, so a turn whose lists haven't changed since the last publish (the common case) doesn't PUT anything. */
  lastSkillsJson: string | undefined;
  /** The Engine's Conversation id, once it is resumable -- what a restart resumes and a Fork carries. */
  conversationId: string | undefined;
  eventBuffer: EventInput[];
  running: boolean;
  /** Set once the relay reports the session gone; suppresses further posting. */
  sessionEnded: boolean;
  /**
   * Background tasks currently believed to be running, mirrored into the
   * state file so a restart can report each as `interrupted` rather than
   * leaving the phone's inline card spinning.
   */
  runningTasks: NonNullable<ConnectorState["runningTasks"]>;
  /**
   * The `requested_at` of the most recent Kill already actioned, so the same
   * request isn't re-sent to the SDK on every poll.
   */
  lastHandledKillAt: string | undefined;

  /**
   * The `requested_at` of the most recent Fork already actioned, so the same
   * `fork_request` isn't re-run on every poll -- mirrors {@link lastHandledKillAt}.
   */
  lastHandledForkAt: string | undefined;

  /**
   * Carries out a Fork by name: `git worktree add`, a generated config, a
   * best-effort transcript copy, and a new connector process, returning that
   * process's Control URL. A field rather than a direct import because the
   * real implementation spawns a detached OS process
   * and waits on its state file, which a test must not do; a test hands this
   * a stub instead.
   */
  readonly executeFork: (name: string) => Promise<ForkOutcome>;

  /**
   * In-memory only, by design: a Command the current Turn was too late to
   * accept (or found alongside the one Steer it already took) goes back to
   * the main loop here and runs as an ordinary Turn before the next relay
   * poll -- not rewound, not re-fetched.
   */
  readonly handBackBuffer: CommandRecord[];

  /**
   * Set while the Engine's Question callback is holding a Turn open on a
   * pending Question, so {@link watchForSteers} knows not to advance the cursor over
   * a Command the stalled Turn cannot read yet.
   */
  questionPending: boolean;

  currentTurn: CurrentTurn | undefined;

  /** The Turn the Engine started on its own, while one is running -- what a Command arriving meanwhile Steers. */
  engineTurn: EngineStartedTurn | undefined;

  /**
   * Whether a Context-window warning has already fired for the current
   * threshold crossing (see CONTEXT.md) -- the edge-trigger's own arm/suppress
   * flag. Set once `context_percentage` crosses the configured threshold, and
   * cleared the moment it drops back below, so the warning fires once per
   * crossing rather than on every subsequent Turn. In-memory only, unlike
   * Auto-compact's equivalent: nothing is lost by re-arming on restart, since
   * a fresh process has no better guess than reading the next real percentage.
   */
  contextWarningActive: boolean;

  /** Serialising flushes keeps event order stable when a flush outlives its interval tick, and lets shutdown await every queued flush. */
  flushChain: Promise<void>;
}
