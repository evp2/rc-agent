import type { PermissionHandler, SessionEvent } from "@github/copilot-sdk";

import { AsyncQueue } from "../../asyncQueue";
import { PERMISSION_MODE } from "../../config";
import type { CopilotProviderConfig } from "../../provider";
import type { Engine, EngineEvent, EngineSession, EngineUsage, OpenOptions } from "../types";
import {
  startCopilotRuntime,
  type CopilotRuntime,
  type CopilotSessionHandle,
  type CopilotSessionOptions,
  type CopilotTask,
} from "./runtime";

export interface CopilotEngineDeps {
  /** Starts the Copilot runtime. Called at most once per Engine. */
  startRuntime: () => Promise<CopilotRuntime>;
  model: string;
}

/** Builds a Copilot adapter on the runtime the provider config names. */
export function createCopilotEngine(provider: CopilotProviderConfig): Engine {
  return new CopilotEngine({ startRuntime: () => startCopilotRuntime(provider), model: provider.model });
}

/**
 * Approves every permission request, the way the connector runs Claude.
 *
 * The SDK's own `approveAll` throws whenever managed settings are in force,
 * which would fail every tool call on a managed machine. This one approves
 * whatever the policy lets a client approve, and leaves anything the policy
 * reserves for itself to the policy.
 */
export const approveEverything: PermissionHandler = (request) => {
  const managed = (request as { managedApprovalRequired?: unknown }).managedApprovalRequired;
  if (managed !== undefined && managed !== false) return { kind: "no-result" };
  return { kind: "approve-once" };
};

type TurnOutcome = Extract<EngineEvent, { type: "turn_ended" }>["outcome"];

interface RunningTurn {
  startedAt: number;
  usage: EngineUsage | undefined;
  errors: string[];
}

/** Said against every Command the connector can no longer hand to Copilot. */
const RUNTIME_GONE = "the Copilot runtime exited";

/**
 * One long-lived Copilot session, translated into neutral Engine events.
 *
 * A Copilot Turn starts with the user message it answers, or, when the agent
 * goes back to work on its own (a detached shell finishing, say), with the
 * first sign of that work. It ends on the main agent loop going idle, or on
 * an abort. Copilot's own `assistant.turn_start`/`turn_end` mark model calls
 * within a Turn, not Turns.
 *
 * Commands are handed to Copilot one at a time, only while it is idle; any
 * sent meanwhile wait here. That keeps each Turn's cause certain, and lets a
 * Stop drop the waiting ones without depending on what Copilot does with its
 * own queue on an abort.
 */
class CopilotEngineSession implements EngineSession {
  private readonly outbox = new AsyncQueue<EngineEvent>();
  /** Commands waiting for Copilot to go idle. */
  private readonly waiting: string[] = [];
  /** Commands a Stop dropped while a Turn was still ending; each is reported once that Turn has. */
  private readonly droppedByStop: string[] = [];
  /** A Command handed to Copilot whose user message hasn't come back yet. */
  private delivering = false;
  /** Set by a Stop that landed while a Command was being handed over: its Turn is aborted as soon as it starts. */
  private abortWhenStarted = false;
  private turn: RunningTurn | undefined;
  private contextPercentage: number | undefined;
  /** Background tasks reported started and not yet settled. */
  private readonly liveTasks = new Map<string, CopilotTask>();
  /** Every task id ever reported, so none is reported twice. */
  private readonly seenTasks = new Set<string>();
  /** Detached shells a Stop killed, whose completion Copilot has yet to report. */
  private readonly shellsKilledByStop = new Set<string>();
  /** Set when one of those completions arrives: the Turn it wakes the agent into is aborted unseen. */
  private quellNextWake = false;
  /** True from the first sign of a quelled wake-up until Copilot confirms it stopped. */
  private quelling = false;
  private refreshingTasks: Promise<void> | undefined;
  private tasksStale = false;
  private dead = false;
  private closed = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly runtime: CopilotRuntime,
    private readonly session: CopilotSessionHandle,
    conversation: Extract<EngineEvent, { type: "conversation" }>,
  ) {
    this.outbox.push(conversation);
    this.unsubscribe = session.on((e) => this.handle(e));
    session.onDisconnected(() => this.runtimeGone());
  }

  get events(): AsyncIterable<EngineEvent> {
    return this.outbox;
  }

  send(text: string): void {
    if (this.closed) return;
    if (this.dead) {
      this.reportUnrun("error", [RUNTIME_GONE]);
      return;
    }
    this.waiting.push(text);
    this.deliverNext();
  }

  steer(): void {
    throw new Error("Steering isn't available on Copilot sessions yet");
  }

  stop(): void {
    const dropped = this.waiting.splice(0);
    // Reported before the stopped Turn ends, so everything a Stop did is
    // visible before the phone hears that Turn is over.
    for (const [taskId] of this.liveTasks) {
      this.outbox.push({ type: "task_settled", taskId, status: "stopped", ambient: false });
    }
    this.liveTasks.clear();

    if (this.turn) {
      this.droppedByStop.push(...dropped);
      void this.abort();
    } else if (this.delivering) {
      this.droppedByStop.push(...dropped);
      this.abortWhenStarted = true;
    } else {
      for (const _ of dropped) this.reportUnrun("stopped");
    }
    // Detached shells and background agents survive an abort, and would
    // wake the agent back into the work the human just stopped.
    void this.cancelBackgroundTasks();
  }

  async killTask(taskId: string): Promise<void> {
    await this.session.cancelTask(taskId).catch(() => undefined);
    this.refreshTasks();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    if (this.turn) this.endTurn("stopped");
    await this.session.disconnect().catch(() => undefined);
    await this.runtime.stop().catch(() => undefined);
    this.outbox.close();
  }

  private deliverNext(): void {
    if (this.turn || this.quelling || this.delivering || this.dead || this.closed) return;
    const text = this.waiting.shift();
    if (text === undefined) return;
    this.delivering = true;
    this.session.send(text).catch((e) => {
      if (!this.delivering) return;
      this.delivering = false;
      this.reportUnrun("error", [(e as Error).message]);
      this.deliverNext();
    });
  }

  private async abort(): Promise<void> {
    try {
      await this.session.abort();
    } catch (e) {
      // No abort event is coming to end the Turn, so end it here.
      console.error("Failed to abort the Copilot Turn:", (e as Error).message);
      if (this.turn) this.endTurn("stopped");
    }
  }

  private async cancelBackgroundTasks(): Promise<void> {
    let tasks: CopilotTask[];
    try {
      tasks = await this.session.listTasks();
    } catch {
      return;
    }
    for (const task of tasks.filter((t) => isBackgroundTask(t) && isRunning(t))) {
      if (task.type === "shell") this.shellsKilledByStop.add(task.id);
      await this.session.cancelTask(task.id).catch(() => undefined);
    }
  }

  private handle(event: SessionEvent): void {
    if (this.closed) return;
    const data = event.data as Record<string, unknown>;
    // A sub-agent's own messages and tool calls belong to the task running
    // it, not to the Turn.
    if (typeof data.parentToolCallId === "string") return;

    if (this.quelling) {
      if (event.type === "abort" || event.type === "assistant.idle") {
        this.quelling = false;
        this.deliverNext();
      }
      return;
    }

    switch (event.type) {
      case "system.notification": {
        const kind = event.data.kind as { type?: string; shellId?: string };
        // Arriving mid-Turn, the news just joins that Turn; only between
        // Turns does it wake the agent.
        if (kind.type === "shell_detached_completed" && kind.shellId && this.shellsKilledByStop.delete(kind.shellId)) {
          this.quellNextWake = !this.turn;
        }
        return;
      }
      case "user.message": {
        this.quellNextWake = false;
        if (this.turn) this.endTurn("success");
        const cause = this.delivering ? "command" : "engine";
        this.delivering = false;
        this.startTurn(cause);
        if (cause === "command" && this.abortWhenStarted) {
          this.abortWhenStarted = false;
          void this.abort();
        }
        return;
      }
      case "assistant.turn_start":
        this.ensureTurn();
        return;
      case "assistant.message": {
        this.ensureTurn();
        if (this.quelling) return;
        const content = event.data.content;
        if (content) this.outbox.push({ type: "assistant_text", text: content });
        return;
      }
      case "tool.execution_start":
        this.ensureTurn();
        if (this.quelling) return;
        this.outbox.push({
          type: "tool_use",
          toolUseId: event.data.toolCallId,
          name: event.data.toolName,
          input: event.data.arguments,
        });
        return;
      case "tool.execution_complete":
        // A result straggling in after its Turn ended belongs to no Turn.
        if (!this.turn) return;
        this.outbox.push({
          type: "tool_result",
          toolUseId: event.data.toolCallId,
          text: event.data.result?.content ?? event.data.error?.message,
          isError: !event.data.success,
        });
        return;
      case "assistant.usage":
        if (this.turn) this.turn.usage = addUsage(this.turn.usage, event.data);
        return;
      case "session.usage_info":
        if (event.data.tokenLimit > 0) {
          this.contextPercentage = Math.round((event.data.currentTokens / event.data.tokenLimit) * 100);
        }
        return;
      case "session.error":
        if (this.turn) this.turn.errors.push(event.data.message);
        else console.error("Copilot:", event.data.message);
        return;
      case "session.auto_mode_resolved":
        this.announce(event.data.chosenModel);
        return;
      case "session.model_change":
        // `auto` is resolved per Turn; the model it picks is announced then.
        if (event.data.newModel !== "auto") this.announce(event.data.newModel);
        return;
      case "session.background_tasks_changed":
        this.refreshTasks();
        return;
      case "abort":
        if (this.turn) this.endTurn("stopped");
        return;
      case "assistant.idle":
        // A wake-up follows its notification directly; by an idle, any that
        // was coming has come.
        this.quellNextWake = false;
        if (this.turn) {
          const outcome: TurnOutcome = event.data.aborted
            ? "stopped"
            : this.turn.errors.length
              ? "error"
              : "success";
          this.endTurn(outcome);
        }
        return;
    }
  }

  private announce(model: string | undefined): void {
    if (model) this.outbox.push({ type: "announce", model, permissionMode: PERMISSION_MODE });
  }

  /**
   * Content with no Turn open means the agent went back to work on its own --
   * unless what woke it was a shell a Stop killed. Copilot reports that shell
   * as completed, and the agent picks the stopped work back up; the human
   * asked for it to stop, so that Turn is aborted before anything of it shows.
   */
  private ensureTurn(): void {
    if (this.turn) return;
    if (this.quellNextWake) {
      this.quellNextWake = false;
      this.quelling = true;
      console.log("Aborting the Turn a stopped Background task woke the agent into.");
      void this.abort();
      return;
    }
    this.startTurn("engine");
  }

  private startTurn(cause: "command" | "engine"): void {
    this.turn = { startedAt: Date.now(), usage: undefined, errors: [] };
    this.outbox.push({ type: "turn_started", cause });
  }

  private endTurn(outcome: TurnOutcome): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    this.outbox.push({
      type: "turn_ended",
      outcome,
      durationMs: Date.now() - turn.startedAt,
      ...(turn.errors.length ? { errors: turn.errors } : {}),
      ...(turn.usage ? { usage: turn.usage } : {}),
      ...(outcome === "success" && this.contextPercentage !== undefined
        ? { contextPercentage: this.contextPercentage }
        : {}),
    });
    for (const _ of this.droppedByStop.splice(0)) this.reportUnrun("stopped");
    this.deliverNext();
  }

  /** A Turn for a Command that never ran, so whoever sent it hears how it ended. */
  private reportUnrun(outcome: "stopped" | "error", errors?: string[]): void {
    this.outbox.push({ type: "turn_started", cause: "command" });
    this.outbox.push({ type: "turn_ended", outcome, durationMs: 0, ...(errors ? { errors } : {}) });
  }

  private runtimeGone(): void {
    if (this.closed || this.dead) return;
    this.dead = true;
    console.error("The Copilot runtime exited.");
    if (this.turn) {
      this.turn.errors.push(RUNTIME_GONE);
      this.endTurn("error");
    }
    if (this.delivering) {
      this.delivering = false;
      this.reportUnrun("error", [RUNTIME_GONE]);
    }
    for (const _ of this.waiting.splice(0)) this.reportUnrun("error", [RUNTIME_GONE]);
  }

  /**
   * Copilot's change notification carries nothing, so the live set is re-read
   * on each one. Bursts of notifications collapse into one read, plus one more
   * if any arrived while it ran.
   */
  private refreshTasks(): void {
    if (this.refreshingTasks) {
      this.tasksStale = true;
      return;
    }
    this.refreshingTasks = (async () => {
      do {
        this.tasksStale = false;
        try {
          this.applyTasks(await this.session.listTasks());
        } catch (e) {
          console.error("Failed to list Copilot tasks:", (e as Error).message);
        }
      } while (this.tasksStale && !this.closed);
      this.refreshingTasks = undefined;
    })();
  }

  private applyTasks(tasks: CopilotTask[]): void {
    if (this.closed) return;
    let changed = false;
    for (const task of tasks.filter(isBackgroundTask)) {
      if (isRunning(task) && !this.seenTasks.has(task.id)) {
        this.seenTasks.add(task.id);
        this.liveTasks.set(task.id, task);
        this.outbox.push({
          type: "task_started",
          taskId: task.id,
          toolUseId: task.toolCallId,
          description: task.description,
          taskType: task.type,
          ambient: false,
        });
        changed = true;
      } else if (!isRunning(task) && this.liveTasks.has(task.id)) {
        this.liveTasks.delete(task.id);
        this.outbox.push({
          type: "task_settled",
          taskId: task.id,
          toolUseId: task.toolCallId,
          status: task.status === "cancelled" ? "stopped" : task.status === "failed" ? "failed" : "completed",
          ambient: false,
        });
        changed = true;
      }
    }
    if (changed) {
      this.outbox.push({
        type: "tasks_changed",
        tasks: [...this.liveTasks.values()].map((t) => ({ taskId: t.id, taskType: t.type, description: t.description })),
      });
    }
  }
}

/** Copilot lists foreground shells as tasks too; only work that runs on its own is a Background task. */
function isBackgroundTask(task: CopilotTask): boolean {
  if (task.type === "shell") return task.attachmentMode === "detached";
  return task.executionMode !== "sync";
}

function isRunning(task: CopilotTask): boolean {
  return task.status === "running" || task.status === "idle";
}

/**
 * Adds one model call's tokens to a Turn's. Copilot's input count includes
 * the cached tokens it also reports separately; the neutral input count is
 * uncached input only, as on Claude, so they are taken out. Copilot's own
 * session totals are computed the same way.
 */
function addUsage(
  sum: EngineUsage | undefined,
  call: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number },
): EngineUsage {
  const cacheRead = call.cacheReadTokens ?? 0;
  const cacheWrite = call.cacheWriteTokens ?? 0;
  return {
    inputTokens: (sum?.inputTokens ?? 0) + Math.max(0, (call.inputTokens ?? 0) - cacheRead - cacheWrite),
    outputTokens: (sum?.outputTokens ?? 0) + (call.outputTokens ?? 0),
    cacheReadTokens: (sum?.cacheReadTokens ?? 0) + cacheRead,
    cacheWriteTokens: (sum?.cacheWriteTokens ?? 0) + cacheWrite,
  };
}

/**
 * The Copilot adapter: everything the Engine seam hides about the Copilot
 * SDK -- its runtime and login, its session events, how a Turn starts and
 * ends, Stop, and resume.
 */
export class CopilotEngine implements Engine {
  readonly kind = "copilot" as const;
  readonly capabilities = { steer: false, fork: false };
  private runtime: Promise<CopilotRuntime> | undefined;

  constructor(private readonly deps: CopilotEngineDeps) {}

  private startRuntime(): Promise<CopilotRuntime> {
    this.runtime ??= this.deps.startRuntime();
    return this.runtime;
  }

  async verify(): Promise<void> {
    const runtime = await this.startRuntime();
    const status = await runtime.authStatus();
    if (!status.isAuthenticated) {
      await this.stopRuntime(runtime);
      // Copilot's own message can be as bare as "Not authenticated".
      throw new Error(
        `Copilot isn't signed in${status.statusMessage ? ` (${status.statusMessage})` : ""}. ` +
          "Run `copilot login`, or set COPILOT_GITHUB_TOKEN.",
      );
    }
  }

  async open(options: OpenOptions): Promise<EngineSession> {
    const runtime = await this.startRuntime();
    try {
      return await this.openOn(runtime, options);
    } catch (e) {
      await this.stopRuntime(runtime);
      throw e;
    }
  }

  /** Leaves no runtime process behind a startup that failed. */
  private async stopRuntime(runtime: CopilotRuntime): Promise<void> {
    this.runtime = undefined;
    await runtime.stop().catch(() => undefined);
  }

  private async openOn(runtime: CopilotRuntime, options: OpenOptions): Promise<EngineSession> {
    const sessionOptions: CopilotSessionOptions = {
      model: this.deps.model,
      workingDirectory: options.projectDir,
      onPermissionRequest: approveEverything,
    };

    if (options.resume) {
      try {
        const session = await runtime.resumeSession(options.resume, sessionOptions);
        return new CopilotEngineSession(runtime, session, { type: "conversation", id: session.sessionId, resumed: true });
      } catch (e) {
        // A Conversation that can't be reopened is never a reason to fail:
        // start fresh and say so. Anything that stops a fresh session too --
        // auth, licence, policy -- fails below, with Copilot's own message.
        console.log(`Couldn't resume Copilot conversation ${options.resume}: ${(e as Error).message}`);
        const session = await runtime.createSession(sessionOptions);
        return new CopilotEngineSession(runtime, session, {
          type: "conversation",
          id: session.sessionId,
          resumed: false,
          lostPrevious: true,
        });
      }
    }
    const session = await runtime.createSession(sessionOptions);
    return new CopilotEngineSession(runtime, session, { type: "conversation", id: session.sessionId, resumed: false });
  }

  async forkConversation(_input: { conversationId: string; fromDir: string; toDir: string }): Promise<string | undefined> {
    throw new Error("Forking isn't available for Copilot sessions yet.");
  }
}
