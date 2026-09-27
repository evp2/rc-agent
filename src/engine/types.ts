import type { SkillInfo } from "../relay/client";

/** Which agent SDK is behind an {@link Engine}. */
export type EngineKind = "claude" | "copilot";

/**
 * The SDK-neutral seam the session code drives. Everything the connector
 * itself decides -- Commands, claims, the cursor, Auto-compact, the
 * Context-window warning -- sits above this interface and is written once.
 * Everything specific to one agent SDK sits below it, inside an adapter.
 */
export interface Engine {
  readonly kind: EngineKind;
  readonly capabilities: {
    /** Whether `steer()` truncates the running Turn at its next tool-call boundary rather than merely queueing behind it. */
    steer: boolean;
  };
  open(options: OpenOptions): Promise<EngineSession>;
  /**
   * Makes `conversationId`'s conversation available to a new connector in
   * `toDir`, returning the id that connector should resume. `undefined`
   * means there was nothing to carry, and the Fork starts fresh.
   */
  forkConversation(input: {
    conversationId: string;
    fromDir: string;
    toDir: string;
  }): Promise<string | undefined>;
}

export interface OpenOptions {
  projectDir: string;
  /** The conversation to resume, from the state file. */
  resume?: string;
  /**
   * Called while a Turn is stalled on a Question. `signal` aborts on
   * `stop()` or `close()`, and the promise must then settle promptly
   * (rejecting is fine).
   */
  onQuestion(question: EngineQuestion, signal: AbortSignal): Promise<EngineAnswer>;
}

export interface EngineSession {
  /** One stream for the whole session. It ends only after `close()`. */
  readonly events: AsyncIterable<EngineEvent>;
  /** Starts a Turn, or queues it behind the Turn already running (see invariants below). */
  send(text: string): void;
  /** Streams a Command into the running Turn. Throws if it cannot be delivered. */
  steer(text: string): void;
  /**
   * Interrupts the running Turn, if any, and ends every Command still queued
   * behind it -- each is reported as a `turn_started` followed by a
   * `turn_ended { outcome: "stopped" }`, so whoever sent it hears how it
   * ended. Idempotent.
   */
  stop(): void;
  /** Kills one Background task. Idempotent; a no-op for an unknown or settled id. */
  killTask(taskId: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * The neutral Question shape: it is the one the relay and phone already
 * carry. Claude's `AskUserQuestion` input is this shape natively. Copilot's
 * single-question `ask_user` becomes a one-element `questions` array.
 */
export interface EngineQuestion {
  toolUseId: string;
  questions: {
    question: string;
    header?: string;
    options: { label: string; description?: string }[];
    multiSelect: boolean;
  }[];
}

export interface EngineAnswer {
  answers: Record<string, string>;
  response?: string;
}

export interface EngineUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Only when the Engine reports money in dollars. Not every Engine does. */
  costUsd?: number;
}

/**
 * Guarantees every adapter meets, checked once by the shared guarantee suite
 * and relied on everywhere above the seam:
 *
 * 1. **Turn pairing.** Every `turn_started` is followed by exactly one
 *    `turn_ended`, including after `stop()`, an SDK error, or the
 *    underlying process dying.
 * 2. **Queueing, and Turns the Engine starts itself.** `send()` is legal at
 *    any time. If a Turn is already running, the text queues and starts
 *    after it, in FIFO order. An Engine may also start a Turn with no
 *    `send()` at all (`cause: "engine"`) -- the connector holds no Command
 *    claim for such a Turn, but a Stop still reaches it.
 * 3. **Steering.** `steer()` is legal only between a `turn_started` and its
 *    `turn_ended`, and only when `capabilities.steer` is true. A delivered
 *    Steer shows up as `turn_ended` followed by `turn_started { cause:
 *    "steer" }`. If `steer()` throws, the Steer never reached the Engine.
 * 4. **Conversation.** `open({ resume })` never throws because a
 *    conversation is missing -- it opens a fresh one and emits `conversation
 *    { resumed: false, lostPrevious: true }`. It does throw for auth,
 *    licence, or managed-settings failures.
 * 5. **Questions.** `onQuestion` is called only inside a Turn, at most once
 *    at a time. The Engine emits no `tool_use` for its own question tool.
 * 6. **Context percentage.** It is computed inside the adapter and attached
 *    to `turn_ended` and `compacted`, each against the Engine's own limit.
 * 7. **Local commands.** A Local command sent as text runs through `send()`
 *    on every Engine and produces a normal `turn_started` … `turn_ended`.
 *    The `menu` event lists only commands the Engine can actually run.
 */
export type EngineEvent =
  | { type: "conversation"; id: string; resumed: boolean; lostPrevious?: boolean }
  | { type: "announce"; model: string; permissionMode: string }
  | { type: "menu"; skills: SkillInfo[]; localCommands: SkillInfo[] }
  | { type: "turn_started"; cause: "command" | "steer" | "engine" }
  | { type: "assistant_text"; text: string }
  | { type: "tool_use"; toolUseId: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; text?: string; isError: boolean }
  | { type: "status"; text: string }
  | { type: "compacting"; trigger: "auto" | "manual" }
  | { type: "compacted"; preTokens?: number; postTokens?: number; contextPercentage?: number }
  | {
      type: "task_started";
      taskId: string;
      toolUseId?: string;
      description?: string;
      taskType?: string;
      ambient: boolean;
    }
  | {
      type: "task_settled";
      taskId: string;
      toolUseId?: string;
      status: "completed" | "failed" | "stopped";
      summary?: string;
      durationMs?: number;
      ambient: boolean;
    }
  | { type: "tasks_changed"; tasks: { taskId: string; taskType?: string; description?: string }[] }
  | {
      type: "turn_ended";
      outcome: "success" | "error" | "stopped";
      errors?: string[];
      durationMs: number;
      usage?: EngineUsage;
      contextPercentage?: number;
    };
