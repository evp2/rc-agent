import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SessionEvent, ToolResultObject } from "@github/copilot-sdk";

import type {
  CopilotCommand,
  CopilotCommandResult,
  CopilotRuntime,
  CopilotSessionHandle,
  CopilotSessionOptions,
  CopilotSkill,
  CopilotTask,
  CopilotUserInputRequest,
  CopilotUserInputResponse,
} from "../src/engine/copilot/runtime.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "copilot");

/**
 * The session events one real Copilot run recorded, in order. The
 * recordings keep only each event's type and data (long strings cut to 240
 * characters), so the envelope fields are filled in here.
 */
export function loadFixture(name: string): SessionEvent[] {
  return readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line, i) => {
      const row = JSON.parse(line) as { type: string; ephemeral?: boolean; data: unknown };
      return {
        id: `fixture-${i}`,
        parentId: null,
        timestamp: new Date(0).toISOString(),
        ...(row.ephemeral ? { ephemeral: true } : {}),
        type: row.type,
        data: row.data,
      } as unknown as SessionEvent;
    });
}

/** Splits a recording at the first event `at` matches: everything before it, and it with everything after. */
export function splitAt(events: SessionEvent[], at: (e: SessionEvent) => boolean): [SessionEvent[], SessionEvent[]] {
  const i = events.findIndex(at);
  if (i < 0) throw new Error("split point not found in the recording");
  return [events.slice(0, i), events.slice(i)];
}

export function event(type: string, data: Record<string, unknown> = {}): SessionEvent {
  return { id: `e-${type}`, parentId: null, timestamp: new Date(0).toISOString(), type, data } as unknown as SessionEvent;
}

/** A plain successful Turn, the way Copilot reports one. */
export function simpleTurn(text = "hi", model = "gpt-test"): SessionEvent[] {
  return [
    event("user.message", { content: "prompt", delivery: "idle" }),
    event("session.auto_mode_resolved", { chosenModel: model }),
    event("assistant.turn_start", { turnId: "0" }),
    event("session.usage_info", { tokenLimit: 1000, currentTokens: 250 }),
    event("assistant.usage", { model, inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1 }),
    event("assistant.message", { messageId: "m1", content: text, toolRequests: [] }),
    event("assistant.turn_end", { turnId: "0" }),
    event("assistant.idle", {}),
    event("session.idle", {}),
  ];
}

/** What the SDK hands the runtime back for one tool call: the handler's result, or the message it threw. */
export type SdkToolReply = { result: string | ToolResultObject } | { error: string };

/** What a fake session does when the adapter calls it. Each reaction may emit events. */
export interface FakeSessionScript {
  /**
   * Called on each `send()`, with how many sends came before it. A promise
   * returned holds the send until it settles, as Copilot's reply can lag.
   */
  onSend?: (session: FakeCopilotSession, prompt: string, index: number) => unknown;
  onAbort?: (session: FakeCopilotSession) => void;
  /** Called on each `interruptMainTurn()`; its return is whether a Turn was interrupted (default true). */
  onInterrupt?: (session: FakeCopilotSession) => boolean | void;
  /** Answers `invokeCommand()`. Absent means every command is refused. */
  onInvoke?: (session: FakeCopilotSession, name: string, input: string | undefined) => Promise<CopilotCommandResult>;
  /** Rejects `send()` when set. */
  sendError?: Error;
}

export class FakeCopilotSession implements CopilotSessionHandle {
  readonly sent: string[] = [];
  readonly cancelled: string[] = [];
  /** Ids of the schedules removed, in order. */
  readonly schedulesStopped: number[] = [];
  /** Ids of the schedules Copilot has registered. */
  schedules: number[] = [];
  readonly invoked: { name: string; input?: string }[] = [];
  aborts = 0;
  interrupts = 0;
  disconnected = false;
  tasks: CopilotTask[] = [];
  commands: CopilotCommand[] = [];
  skills: CopilotSkill[] = [];
  /** How many of the next command-list reads fail. */
  failCommandReads = 0;
  private readonly handlers = new Set<(event: SessionEvent) => void>();
  private disconnectHandler: (() => void) | undefined;

  constructor(
    readonly sessionId: string,
    readonly options: CopilotSessionOptions,
    private readonly script: FakeSessionScript = {},
  ) {}

  on(handler: (event: SessionEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onDisconnected(handler: () => void): void {
    this.disconnectHandler = handler;
  }

  /** Delivers events the way the SDK does: after the call that caused them has returned. */
  emit(events: SessionEvent[]): void {
    setImmediate(() => {
      for (const e of events) for (const h of this.handlers) h(e);
    });
  }

  /** Simulates the runtime process dying. */
  die(): void {
    setImmediate(() => this.disconnectHandler?.());
  }

  async send(prompt: string): Promise<void> {
    if (this.script.sendError) throw this.script.sendError;
    const index = this.sent.length;
    this.sent.push(prompt);
    const reaction = this.script.onSend?.(this, prompt, index);
    if (reaction instanceof Promise) await reaction;
  }

  async abort(): Promise<void> {
    this.aborts += 1;
    this.script.onAbort?.(this);
  }

  /** Asks the question the way Copilot's `ask_user` tool does: through the handler the adapter gave at open. */
  ask(request: CopilotUserInputRequest): Promise<CopilotUserInputResponse> {
    return this.options.onUserInputRequest(request);
  }

  /**
   * Runs a tool the adapter registered, the way the SDK does when the model
   * calls it, and returns what the SDK would hand the runtime back.
   */
  async callTool(
    name: string,
    args: unknown,
    toolCallId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<SdkToolReply> {
    const tool = this.options.tools?.find((t) => t.name === name);
    if (!tool?.handler) throw new Error(`no tool named ${name} was registered`);
    try {
      const invocation = { sessionId: this.sessionId, toolCallId, toolName: name, arguments: args, signal };
      const raw = await tool.handler(args, invocation);
      // The SDK's own normalization: a result object passes through, a
      // string is the text, anything else is sent as JSON.
      if (raw == null) return { result: "" };
      if (typeof raw === "string") return { result: raw };
      const object = raw as { textResultForLlm?: unknown; resultType?: unknown };
      if (typeof object.textResultForLlm === "string" && typeof object.resultType === "string") {
        return { result: raw as ToolResultObject };
      }
      return { result: JSON.stringify(raw) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  async interruptMainTurn(): Promise<boolean> {
    this.interrupts += 1;
    return this.script.onInterrupt?.(this) ?? true;
  }

  async listCommands(): Promise<CopilotCommand[]> {
    if (this.failCommandReads > 0) {
      this.failCommandReads -= 1;
      throw new Error("commands.list timed out");
    }
    return this.commands;
  }

  async listSkills(): Promise<CopilotSkill[]> {
    return this.skills;
  }

  async invokeCommand(name: string, input?: string): Promise<CopilotCommandResult> {
    this.invoked.push({ name, ...(input !== undefined ? { input } : {}) });
    if (!this.script.onInvoke) throw new Error(`Unknown command: /${name}`);
    return this.script.onInvoke(this, name, input);
  }

  async listTasks(): Promise<CopilotTask[]> {
    return this.tasks;
  }

  async cancelTask(id: string): Promise<void> {
    this.cancelled.push(id);
    const task = this.tasks.find((t) => t.id === id);
    if (task) task.status = "cancelled";
  }

  /** Removes a schedule the way Copilot does, announcing it cancelled (measured on CLI 1.0.88). */
  async listSchedules(): Promise<number[]> {
    return this.schedules;
  }

  async stopSchedule(id: number): Promise<void> {
    this.schedulesStopped.push(id);
    this.schedules = this.schedules.filter((s) => s !== id);
    this.emit([event("session.schedule_cancelled", { id })]);
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

export class FakeCopilotRuntime implements CopilotRuntime {
  readonly sessions: FakeCopilotSession[] = [];
  stopped = false;
  auth: { isAuthenticated: boolean; statusMessage?: string } = { isAuthenticated: true };
  /** Conversation ids `resumeSession` can find. */
  readonly known = new Set<string>();
  /** Makes `createSession` reject, as Copilot does when policy forbids a session. */
  createError: Error | undefined;

  constructor(private readonly script: FakeSessionScript = {}) {}

  get session(): FakeCopilotSession {
    const s = this.sessions.at(-1);
    if (!s) throw new Error("no session opened");
    return s;
  }

  async authStatus() {
    return this.auth;
  }

  async createSession(options: CopilotSessionOptions): Promise<FakeCopilotSession> {
    if (this.createError) throw this.createError;
    const s = new FakeCopilotSession(`copilot-${this.sessions.length + 1}`, options, this.script);
    this.sessions.push(s);
    return s;
  }

  async resumeSession(id: string, options: CopilotSessionOptions): Promise<FakeCopilotSession> {
    if (!this.known.has(id)) throw new Error(`Session not found: ${id}`);
    const s = new FakeCopilotSession(id, options, this.script);
    this.sessions.push(s);
    return s;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}
