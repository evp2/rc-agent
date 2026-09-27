import { randomUUID } from "node:crypto";

import { AsyncQueue } from "../asyncQueue";
import type { SkillInfo } from "../relay/client";
import type {
  Engine,
  EngineAnswer,
  EngineEvent,
  EngineKind,
  EngineQuestion,
  EngineSession,
  EngineUsage,
  OpenOptions,
} from "./types";

/** What a scripted Turn's body can do and observe, handed to a {@link FakeTurnHandler}. */
export interface FakeTurnContext {
  readonly cause: "command" | "steer" | "engine";
  /** The text that started this Turn -- its own Command or Steer text; `undefined` for an Engine-started Turn. */
  readonly text: string | undefined;
  /** Emits one neutral event inside this Turn. `turn_started`/`turn_ended` are the session's own job, not the handler's. */
  emit(event: Exclude<EngineEvent, { type: "turn_started" } | { type: "turn_ended" }>): void;
  /** Invokes `onQuestion` exactly as a real Engine would, and returns the Answer. */
  ask(question: EngineQuestion): Promise<EngineAnswer>;
  /**
   * Resolves the next time `steer()` is called while this Turn is running,
   * with the steered text. A handler that means to be steerable races this
   * against its own work and returns promptly once it resolves -- the
   * session then emits this Turn's `turn_ended` and starts the Steer's own
   * Turn. A handler that ignores it and keeps working anyway behaves like a
   * real adapter that ignores its abort signal: believable Steering is the
   * script's responsibility, not something the fake can force.
   */
  waitForSteer(): Promise<string>;
  /** True once `stop()` has been called for this Turn. */
  readonly stopped: boolean;
  /** Resolves the moment `stop()` is called for this Turn. Already-resolved if it already has been. */
  waitForStop(): Promise<void>;
  /**
   * Resolves the moment this Turn is cut short, by a Steer or by `stop()`,
   * without taking the Steer itself (the session does that). What a
   * steerable handler races its pauses against, so it stops producing
   * events for a Turn that has already ended.
   */
  waitForInterruption(): Promise<void>;
}

export interface FakeTurnOutcome {
  outcome?: "success" | "error" | "stopped";
  errors?: string[];
  usage?: EngineUsage;
  contextPercentage?: number;
}

export type FakeTurnHandler = (ctx: FakeTurnContext) => Promise<FakeTurnOutcome | void>;

export interface FakeEngineScript {
  kind?: EngineKind;
  capabilities?: { steer: boolean };
  /** The conversation id this session already has, if any -- what `resume` must match for `open()` to report a resumed (not lost) Conversation. */
  conversationId?: string;
  /** The id a fresh Conversation gets, when there was nothing (matching or otherwise) to resume. Random when omitted. */
  freshConversationId?: string;
  /** Thrown from `open()` itself -- the auth/licence/managed-settings failure case. */
  failOpen?: Error;
  /** Thrown from `verify()` -- the signed-out case, caught at startup. */
  failVerify?: Error;
  /** Announced right after the Conversation, if given. */
  announce?: { model: string; permissionMode: string };
  /** Published right after the announcement, if given. */
  menu?: { skills: SkillInfo[]; localCommands: SkillInfo[] };
  /** Chosen once per Turn, by its cause and (for a Command or a Steer) its text. */
  handlerFor(cause: "command" | "steer" | "engine", text: string | undefined): FakeTurnHandler;
  /**
   * Runs inside the Turn a Steer is truncating, after the Steer lands and
   * before that Turn ends -- widening the window between the Engine taking a
   * Steer and confirming it with the Steer's own `turn_started`, so a test
   * can land a Stop inside it. A Stop there cancels the Steer's Turn.
   */
  beforeSteerConfirm?: (ctx: FakeTurnContext, steeredText: string) => Promise<void>;
  /** What `forkConversation` resolves to. Defaults to echoing the same id back (a successful carry). */
  forkConversation?: Engine["forkConversation"];
}

type QueueEntry = { kind: "command"; text: string; stopped?: boolean } | { kind: "engine" };

/**
 * A live FakeEngine session, with the ordinary {@link EngineSession} surface
 * plus one extra a test uses to simulate the Engine starting a Turn on its
 * own -- something no `send()`/`steer()` call can trigger, since by
 * definition nothing sent it.
 */
export interface FakeEngineSession extends EngineSession {
  /** Queues a Turn with cause `"engine"`, behind whatever is already running -- the fake's analogue of a real Engine noticing a Background task finished and picking the conversation back up unprompted. */
  triggerEngineTurn(): void;
}

/**
 * Turn-scoped controller state, kept out of {@link FakeTurnContext} itself so
 * the session can drive it (resolve the Steer queue, flip `stopped`) without
 * exposing those methods to the handler.
 */
class TurnController implements FakeTurnContext {
  /** The Steer this Turn took, if any -- at most one: the Steer's own Turn replaces this one. */
  steeredText: string | undefined;
  private readonly steerWaiters: ((text: string) => void)[] = [];
  stopped = false;
  private readonly stopWaiters: (() => void)[] = [];
  private readonly interruptionWaiters: (() => void)[] = [];
  private interrupted = false;

  constructor(
    readonly cause: "command" | "steer" | "engine",
    readonly text: string | undefined,
    private readonly session: FakeEngineSessionImpl,
  ) {}

  emit(event: Exclude<EngineEvent, { type: "turn_started" } | { type: "turn_ended" }>): void {
    this.session.pushEvent(event);
  }

  ask(question: EngineQuestion): Promise<EngineAnswer> {
    return this.session.askQuestion(question, this);
  }

  waitForSteer(): Promise<string> {
    // A Turn that ends (or is stopped) without ever being Steered leaves this
    // hanging rather than rejecting, since nothing is left that will ever
    // consume it: runTurn() has already moved on by the time it could settle.
    if (this.steeredText !== undefined) return Promise.resolve(this.steeredText);
    return new Promise((resolve) => this.steerWaiters.push(resolve));
  }

  waitForStop(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => this.stopWaiters.push(resolve));
  }

  waitForInterruption(): Promise<void> {
    if (this.interrupted) return Promise.resolve();
    return new Promise((resolve) => this.interruptionWaiters.push(resolve));
  }

  /** A Steer landed for this Turn. Throws if it already took one: the Steer's own Turn is about to replace it. */
  receiveSteer(text: string): void {
    if (this.steeredText !== undefined) throw new Error("this Turn has already been Steered");
    this.steeredText = text;
    for (const resolve of this.steerWaiters.splice(0)) resolve(text);
    this.markInterrupted();
  }

  private markInterrupted(): void {
    this.interrupted = true;
    for (const resolve of this.interruptionWaiters.splice(0)) resolve();
  }

  /** Called by the session when `stop()` targets this Turn. Idempotent. */
  markStopped(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const resolve of this.stopWaiters.splice(0)) resolve();
    this.markInterrupted();
  }
}

/**
 * One pending `onQuestion` call, tracked so `stop()` can settle it the way
 * the real invariant requires: the callback's `signal` aborts, and its
 * promise must then settle promptly.
 */
interface PendingQuestion {
  abortController: AbortController;
}

class FakeEngineSessionImpl implements FakeEngineSession {
  private readonly canSteer: boolean;
  private readonly queue: QueueEntry[] = [];
  private readonly outbox = new AsyncQueue<EngineEvent>();
  private running = true;
  private currentTurn: TurnController | undefined;
  private pendingQuestion: PendingQuestion | undefined;
  private readonly pumpPromise: Promise<void>;
  private wake: (() => void) | undefined;

  constructor(
    private readonly script: FakeEngineScript,
    private readonly options: OpenOptions,
  ) {
    this.canSteer = script.capabilities?.steer ?? true;
    this.pumpPromise = this.pump();
  }

  get events(): AsyncIterable<EngineEvent> {
    return this.outbox;
  }

  pushEvent(event: EngineEvent): void {
    this.outbox.push(event);
  }

  askQuestion(question: EngineQuestion, turn: TurnController): Promise<EngineAnswer> {
    const abortController = new AbortController();
    if (turn.stopped) abortController.abort();
    else void turn.waitForStop().then(() => abortController.abort());
    this.pendingQuestion = { abortController };
    return this.options.onQuestion(question, abortController.signal).finally(() => {
      this.pendingQuestion = undefined;
    });
  }

  send(text: string): void {
    if (!this.running) return;
    this.queue.push({ kind: "command", text });
    this.wake?.();
  }

  steer(text: string): void {
    if (!this.canSteer) throw new Error("this fake Engine cannot Steer");
    const turn = this.currentTurn;
    if (!turn || turn.stopped) throw new Error("no running Turn to Steer");
    turn.receiveSteer(text);
  }

  stop(): void {
    this.currentTurn?.markStopped();
    this.pendingQuestion?.abortController.abort();
    // A Stop ends queued Commands too, each reported as a Turn that started
    // and was stopped, so whoever sent one hears how it ended. A queued
    // Engine-started Turn nobody asked for is simply dropped.
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const entry = this.queue[i];
      if (entry.kind === "command") entry.stopped = true;
      else this.queue.splice(i, 1);
    }
  }

  async killTask(): Promise<void> {
    // The fake tracks no per-task lifecycle beyond what a handler chooses to
    // emit, so killing one is a no-op here -- idempotent by construction.
  }

  async close(): Promise<void> {
    this.running = false;
    // A handler that doesn't watch `waitForStop()` could otherwise hold this
    // open forever -- close() ending the whole session is a stronger promise
    // than stop() ending one Turn, so it implies one.
    this.stop();
    this.wake?.();
    await this.pumpPromise;
    this.outbox.close();
  }

  triggerEngineTurn(): void {
    if (!this.running) return;
    this.queue.push({ kind: "engine" });
    this.wake?.();
  }

  private nextEntry(): Promise<QueueEntry | undefined> {
    // Closed takes priority over whatever is still queued -- close() ending
    // the whole session is a stronger promise than draining leftover work,
    // and starting a fresh Turn nothing will ever stop would hang close()
    // forever waiting on it.
    if (!this.running) return Promise.resolve(undefined);
    const shifted = this.queue.shift();
    if (shifted) return Promise.resolve(shifted);
    return new Promise((resolve) => {
      this.wake = () => {
        this.wake = undefined;
        resolve(this.running ? this.queue.shift() : undefined);
      };
    });
  }

  private async pump(): Promise<void> {
    await this.announceConversation();
    for (;;) {
      const entry = await this.nextEntry();
      if (!entry) {
        if (!this.running) return;
        continue;
      }
      await this.runTurn(entry);
      if (!this.running && this.queue.length === 0) return;
    }
  }

  private async announceConversation(): Promise<void> {
    const resumeTarget = this.options.resume;
    let id: string;
    let resumed: boolean;
    let lostPrevious: true | undefined;
    if (resumeTarget) {
      if (this.script.conversationId && this.script.conversationId === resumeTarget) {
        id = this.script.conversationId;
        resumed = true;
      } else {
        id = this.script.freshConversationId ?? randomUUID();
        resumed = false;
        lostPrevious = true;
      }
    } else {
      id = this.script.conversationId ?? this.script.freshConversationId ?? randomUUID();
      resumed = false;
    }
    this.pushEvent({ type: "conversation", id, resumed, ...(lostPrevious ? { lostPrevious } : {}) });
    if (this.script.announce) this.pushEvent({ type: "announce", ...this.script.announce });
    if (this.script.menu) this.pushEvent({ type: "menu", ...this.script.menu });
  }

  private async runTurn(entry: QueueEntry): Promise<void> {
    const cause = entry.kind === "command" ? "command" : "engine";
    const text = entry.kind === "command" ? entry.text : undefined;
    this.pushEvent({ type: "turn_started", cause });
    if (entry.kind === "command" && entry.stopped) {
      this.pushEvent({ type: "turn_ended", outcome: "stopped", durationMs: 0 });
      return;
    }
    const startedAt = Date.now();
    let turn = new TurnController(cause, text, this);
    this.currentTurn = turn;
    let handler = this.script.handlerFor(cause, text);
    let finalOutcome: FakeTurnOutcome | undefined;

    for (;;) {
      let steeredText: string | undefined;
      try {
        const raced = await Promise.race([
          handler(turn).then((result) => ({ kind: "finished" as const, result })),
          turn.waitForSteer().then((text_) => ({ kind: "steered" as const, text: text_ })),
        ]);
        if (raced.kind === "finished") finalOutcome = raced.result ?? {};
      } catch (e) {
        // A handler whose Question (or anything else) was cut off by a Stop
        // rejects -- that is the Stop landing, not a failure.
        finalOutcome = turn.stopped ? { outcome: "stopped" } : { outcome: "error", errors: [(e as Error).message] };
      }
      // Read off the Turn rather than the race: a handler watching
      // waitForInterruption() can finish in the same tick the Steer lands,
      // and win the race, without the Steer being any less delivered. A Stop
      // outranks a Steer, which it discards.
      if (!turn.stopped) steeredText = turn.steeredText;

      if (steeredText === undefined) break;

      if (this.script.beforeSteerConfirm) {
        await this.script.beforeSteerConfirm(turn, steeredText);
        if (turn.stopped) {
          finalOutcome = { outcome: "stopped" };
          break;
        }
      }

      // A delivered Steer: this sub-turn ends, and the Steer's own Turn
      // begins in its place -- turn_ended then turn_started { cause: "steer"
      // }, exactly as the invariant requires.
      this.pushEvent({
        type: "turn_ended",
        outcome: turn.stopped ? "stopped" : "success",
        durationMs: Date.now() - startedAt,
      });
      this.pushEvent({ type: "turn_started", cause: "steer" });
      turn = new TurnController("steer", steeredText, this);
      this.currentTurn = turn;
      handler = this.script.handlerFor("steer", steeredText);
    }

    this.currentTurn = undefined;
    const outcome = finalOutcome ?? {};
    this.pushEvent({
      type: "turn_ended",
      outcome: outcome.outcome ?? (turn.stopped ? "stopped" : "success"),
      errors: outcome.errors,
      durationMs: Date.now() - startedAt,
      usage: outcome.usage,
      contextPercentage: outcome.contextPercentage,
    });
  }
}

/**
 * A scripted fake Engine: every adapter-facing mechanic (the queue, Steer's
 * end-then-start ordering, Stop, Questions, a lost Conversation) is real,
 * driven by the same session state machine a real adapter would need; only a
 * Turn's own content -- what it says, which tools it calls, whether it
 * starts a Background task -- is supplied by the test through
 * {@link FakeEngineScript.handlerFor}.
 */
export class FakeEngine implements Engine {
  readonly kind: EngineKind;
  readonly capabilities: { steer: boolean };

  constructor(private readonly script: FakeEngineScript) {
    this.kind = script.kind ?? "claude";
    this.capabilities = { steer: script.capabilities?.steer ?? true };
  }

  async verify(): Promise<void> {
    if (this.script.failVerify) throw this.script.failVerify;
  }

  async open(options: OpenOptions): Promise<FakeEngineSession> {
    if (this.script.failOpen) throw this.script.failOpen;
    return new FakeEngineSessionImpl(this.script, options);
  }

  forkConversation(input: { conversationId: string; fromDir: string; toDir: string }): Promise<string | undefined> {
    if (this.script.forkConversation) return this.script.forkConversation(input);
    return Promise.resolve(input.conversationId);
  }
}

// --- Canned handlers, for tests that don't need a bespoke script ----------

/** A Turn that says one line and ends successfully, ignoring any Steer. */
export function sayAndFinish(text: string): FakeTurnHandler {
  return async (ctx) => {
    ctx.emit({ type: "assistant_text", text });
    return { outcome: "success" };
  };
}

/** A Turn that runs one tool call and reports its result before finishing. */
export function useToolAndFinish(name: string, input: unknown, resultText: string): FakeTurnHandler {
  return async (ctx) => {
    const toolUseId = `toolu_${randomUUID()}`;
    ctx.emit({ type: "tool_use", toolUseId, name, input });
    ctx.emit({ type: "tool_result", toolUseId, text: resultText, isError: false });
    return { outcome: "success" };
  };
}

/** A Turn that asks one Question and reports what it was told. */
export function askAndFinish(question: EngineQuestion): FakeTurnHandler {
  return async (ctx) => {
    const answer = await ctx.ask(question);
    ctx.emit({ type: "assistant_text", text: `answered: ${JSON.stringify(answer.answers)}` });
    return { outcome: "success" };
  };
}

/**
 * A Turn that starts a Background task, finishes its own work immediately
 * (mirroring a real Engine's Turn ending while Background work runs on), and
 * settles the task only once `settleAfter` resolves -- letting a test control
 * exactly when that happens rather than racing a timer.
 */
export function startBackgroundTaskAndFinish(
  taskId: string,
  settleAfter: Promise<void>,
  opts: { toolUseId?: string; description?: string; taskType?: string } = {},
): FakeTurnHandler {
  return async (ctx) => {
    ctx.emit({
      type: "task_started",
      taskId,
      toolUseId: opts.toolUseId,
      description: opts.description,
      taskType: opts.taskType,
      ambient: false,
    });
    void settleAfter.then(() => {
      ctx.emit({ type: "task_settled", taskId, toolUseId: opts.toolUseId, status: "completed", ambient: false });
    });
    return { outcome: "success" };
  };
}

/** A Turn that reports itself compacting (automatically) and finishes. */
export function compactAndFinish(preTokens: number, postTokens: number, contextPercentage: number): FakeTurnHandler {
  return async (ctx) => {
    ctx.emit({ type: "compacting", trigger: "auto" });
    ctx.emit({ type: "compacted", preTokens, postTokens, contextPercentage });
    return { outcome: "success", contextPercentage };
  };
}

/** A Turn that fails outright. */
export function failWith(message: string): FakeTurnHandler {
  return async () => ({ outcome: "error", errors: [message] });
}

/** A Turn that does nothing until `stop()` lands, then reports itself stopped. Steer is handled by the session itself, outside the handler (see the race in `runTurn`). */
export function hangUntilStopped(): FakeTurnHandler {
  return async (ctx) => {
    await ctx.waitForStop();
    return { outcome: "stopped" };
  };
}
