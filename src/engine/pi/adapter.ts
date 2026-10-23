import type { Usage } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  type SessionEntry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { AsyncQueue } from "../../asyncQueue";
import { PERMISSION_MODE } from "../../config";
import type { PiProviderConfig, ProviderConfig } from "../../provider";
import type { SkillInfo } from "../../relay/client";
import {
  CONNECTOR_QUESTION_ID_PREFIX,
  type Engine,
  type EngineEvent,
  type EngineQuestion,
  type EngineSession,
  type EngineUsage,
  type OpenOptions,
} from "../types";
import { chooseEffort, chooseModel } from "./modelCommands";
import { connectorTools, QUESTION_TOOL } from "./tools";

const PI_PROVIDERS: Record<ProviderConfig["type"], string> = {
  anthropic: "anthropic",
  bedrock: "amazon-bedrock",
  copilot: "github-copilot",
};

export interface PiEngineDeps {
  provider: PiProviderConfig;
  projectDir: string;
  homeDir?: string;
  createModelRuntime?: () => Promise<ModelRuntime>;
}

export function createPiEngine(provider: PiProviderConfig, projectDir: string): Engine {
  return new PiEngine({ provider, projectDir });
}

type PiModel = NonNullable<AgentSession["model"]>;

export class PiEngine implements Engine {
  readonly kind = "pi" as const;
  readonly capabilities = { steer: true };
  private readonly createModelRuntime: () => Promise<ModelRuntime>;

  constructor(private readonly deps: PiEngineDeps) {
    this.createModelRuntime = deps.createModelRuntime ?? (() => ModelRuntime.create());
  }

  async verify(): Promise<void> {
    const session = await this.startSession(this.deps.projectDir, SessionManager.inMemory(this.deps.projectDir));
    await endSession(session);
  }

  async open(options: OpenOptions): Promise<EngineSession> {
    const cwd = options.projectDir;
    const previous = options.resume ? SessionManager.findById(cwd, options.resume) : undefined;
    const session = await this.startSession(
      cwd,
      previous ? SessionManager.open(previous) : SessionManager.create(cwd),
      connectorTools(options),
    );
    return new PiEngineSession(
      session,
      {
        type: "conversation",
        id: session.sessionId,
        resumed: previous !== undefined,
        ...(options.resume && !previous ? { lostPrevious: true } : {}),
      },
      { piProvider: PI_PROVIDERS[this.deps.provider.type], onQuestion: options.onQuestion },
      options.onArchiveFile,
    );
  }

  // Pi's session creation succeeds with no model or credential and fails only at the first prompt.
  private async startSession(
    cwd: string,
    sessionManager: SessionManager,
    customTools: ToolDefinition[] = [],
  ): Promise<AgentSession> {
    const { provider } = this.deps;
    const agentDir = getAgentDir();
    const modelRuntime = await this.createModelRuntime();
    const piProvider = PI_PROVIDERS[provider.type];
    const branch = sessionManager.getBranch();
    const chosenAlready = switchedIn(branch, "model_change");
    const effortChosenAlready = switchedIn(branch, "thinking_level_change");
    let model: PiModel | undefined;
    if (provider.model && !chosenAlready) {
      model = modelRuntime.getModel(piProvider, provider.model);
      if (!model) {
        throw new Error(
          `provider.model '${provider.model}' is not a Pi model on ${piProvider}. ` +
            `Set provider.model in the connector config to one that \`pi --list-models\` lists for ${piProvider}.`,
        );
      }
    }
    const settingsManager = SettingsManager.create(cwd, agentDir);
    // Pi keeps the first Skill of a name, so these load after its own.
    const claudeSkills = [join(cwd, ".claude", "skills"), join(this.deps.homeDir ?? homedir(), ".claude", "skills")];
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      extensionFactories: [createCodemodeExtension({ mode: "on" }), createToolSearchExtension(), createMcpExtension()],
      additionalSkillPaths: claudeSkills,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager,
      customTools,
      ...(model ? { model } : {}),
      ...(provider.thinkingLevel && !effortChosenAlready && !chosenAlready ? { thinkingLevel: provider.thinkingLevel } : {}),
    });
    // With no model to pick, Pi leaves a placeholder in place rather than none.
    const chosen = session.model && modelRuntime.getModel(session.model.provider, session.model.id);
    try {
      await checkRunnable(chosen, provider, modelRuntime);
      await session.bindExtensions({});
    } catch (e) {
      await endSession(session);
      throw e;
    }
    return session;
  }
}

// dispose() alone skips session_shutdown, which is what closes the MCP servers' connections and child processes.
async function endSession(session: AgentSession): Promise<void> {
  try {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    session.dispose();
  }
}

// Pi writes a model_change and thinking_level_change when it creates a session; only a later one is a switch.
function switchedIn(branch: SessionEntry[], type: "model_change" | "thinking_level_change"): boolean {
  const first = branch.findIndex((e) => e.type === type);
  if (first < 0) return false;
  const firstMessage = branch.findIndex((e) => e.type === "message");
  return branch.some((e, i) => e.type === type && i > first) || (firstMessage >= 0 && firstMessage < first);
}

async function checkRunnable(
  model: PiModel | undefined,
  provider: PiProviderConfig,
  modelRuntime: ModelRuntime,
): Promise<void> {
  const piProvider = PI_PROVIDERS[provider.type];
  if (!model) {
    throw new Error(
      `Pi has no model to run. Set provider.model in the connector config to a Pi model on ${piProvider}, ` +
        "or sign in and choose a default model in Pi (run `pi`, then /login and /model).",
    );
  }
  const name = `${model.provider}/${model.id}`;
  const relayProvider = (Object.keys(PI_PROVIDERS) as ProviderConfig["type"][]).find(
    (type) => PI_PROVIDERS[type] === model.provider,
  );
  if (!relayProvider) {
    throw new Error(
      `Pi's model ${name} is on provider '${model.provider}', which the relay doesn't accept ` +
        `(only ${Object.values(PI_PROVIDERS).join(", ")}). ` +
        `Set provider.model in the connector config to a model on ${piProvider}.`,
    );
  }
  if (relayProvider !== provider.type) {
    throw new Error(
      `Pi's model ${name} is on provider '${model.provider}', but provider.type is '${provider.type}'. ` +
        `Set provider.type to '${relayProvider}', or provider.model to a model on ${piProvider}.`,
    );
  }
  const signedIn =
    modelRuntime.hasConfiguredAuth(model.provider) || (await modelRuntime.checkAuth(model.provider)) !== undefined;
  if (!signedIn) {
    throw new Error(
      `Pi has no credential for '${model.provider}'. Sign in with \`pi\`, then /login ${model.provider}, ` +
        "or set the provider's API key in the environment.",
    );
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type TurnOutcome = Extract<EngineEvent, { type: "turn_ended" }>["outcome"];

interface RunningTurn {
  startedAt: number;
  promptStarted: boolean;
  ended: boolean;
  /** Re-applied at agent_start, in case the Stop landed before there was a run to abort. */
  stopRequested: boolean;
  /** Cleared by a later successful call, so a retried call is not the Turn's error. */
  modelError: string | undefined;
  usage: EngineUsage | undefined;
}

interface PendingSteer {
  text: string;
  queued: Promise<Error | undefined>;
  stopped: boolean;
}

// A Turn ends on Pi's agent_settled, not agent_end: a compaction or retry can follow agent_end.
class PiEngineSession implements EngineSession {
  private readonly outbox = new AsyncQueue<EngineEvent>();
  private readonly waiting: string[] = [];
  private stoppedWhileRunning = 0;
  private turn: RunningTurn | undefined;
  private steering: PendingSteer | undefined;
  private closed = false;
  private unannounced: Extract<EngineEvent, { type: "conversation" }> | undefined;
  private readonly unsubscribe: () => void;
  private questions = new AbortController();
  private ownQuestions = 0;

  constructor(
    private readonly session: AgentSession,
    conversation: Extract<EngineEvent, { type: "conversation" }>,
    private readonly asking: { piProvider: string; onQuestion: OpenOptions["onQuestion"] },
    private readonly onArchiveFile?: OpenOptions["onArchiveFile"],
  ) {
    if (conversation.resumed) this.outbox.push(conversation);
    else this.unannounced = conversation;
    if (session.model) this.outbox.push({ type: "announce", model: session.model.id, permissionMode: PERMISSION_MODE });
    this.outbox.push({ type: "menu", ...menu(session) });
    this.unsubscribe = session.subscribe((e) => this.handle(e));
  }

  get events(): AsyncIterable<EngineEvent> {
    return this.outbox;
  }

  send(text: string): void {
    if (this.closed) return;
    if (this.turn) this.waiting.push(text);
    else void this.run(text, "command");
  }

  steer(text: string): void {
    if (!this.turn || this.turn.ended || this.closed) throw new Error("there is no running Turn to Steer");
    if (this.steering) throw new Error("a Steer is already on its way into this Turn");
    this.steering = {
      text,
      queued: this.session.steer(text).then(
        () => undefined,
        (e: unknown) => new Error(messageOf(e)),
      ),
      stopped: false,
    };
  }

  stop(): void {
    const queued = this.waiting.splice(0);
    this.session.clearQueue();
    if (this.steering && !this.steering.stopped) {
      this.steering.stopped = true;
      // Pi queues a Steer only after an await, so it can land after the clear above.
      void this.steering.queued.then(() => this.session.clearQueue());
    }
    if (this.turn) {
      this.turn.stopRequested = true;
      this.questions.abort();
      this.stoppedWhileRunning += queued.length;
      void this.session.abort();
    } else {
      for (const _ of queued) this.reportUnrun("command", "stopped");
    }
  }

  async killTask(): Promise<void> {}

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.questions.abort();
    this.waiting.length = 0;
    this.steering = undefined;
    this.session.clearQueue();
    await this.session.abort();
    this.unsubscribe();
    await endSession(this.session);
    this.outbox.close();
  }

  private startTurn(cause: "command" | "steer"): RunningTurn {
    const turn: RunningTurn = {
      startedAt: Date.now(),
      promptStarted: false,
      ended: false,
      stopRequested: false,
      modelError: undefined,
      usage: undefined,
    };
    this.turn = turn;
    this.outbox.push({ type: "turn_started", cause });
    return turn;
  }

  private async run(text: string, cause: "command" | "steer"): Promise<void> {
    const turn = this.startTurn(cause);
    this.questions = new AbortController();
    const trimmed = text.trim();
    const compact = /^\/compact(?:\s+([\s\S]*))?$/.exec(trimmed);
    const [, word = "", rest = ""] = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(trimmed) ?? [];
    if (compact) await this.compact(turn, compact[1] || undefined);
    else if (word === "clear" && !rest) await this.clear(turn);
    else if (word === "model") await this.switchModel(turn, "model", rest);
    else if (word === "effort") await this.switchModel(turn, "effort", rest);
    else if (word === "session") this.localStatus(turn, () => sessionStatus(this.session));
    else if (word === "name") this.localStatus(turn, () => this.name(rest.trim()));
    else if (word === "reload") await this.reload(turn);
    else if (word === "export") await this.exportSession(turn);
    else await this.prompt(turn, text);
    const missed = this.steering;
    this.steering = undefined;
    const missedRefusal = missed && (await missed.queued);
    if (missed) this.session.clearQueue();
    this.turn = undefined;
    if (missed?.stopped) this.reportUnrun("steer", "stopped");
    else if (missedRefusal) this.reportUnrun("steer", "error", missedRefusal.message);
    for (; this.stoppedWhileRunning > 0; this.stoppedWhileRunning--) this.reportUnrun("command", "stopped");
    if (this.closed) return;
    if (missed && !missed.stopped && !missedRefusal) {
      void this.run(missed.text, "steer");
      return;
    }
    const next = this.waiting.shift();
    if (next !== undefined) void this.run(next, "command");
  }

  private async prompt(turn: RunningTurn, text: string): Promise<void> {
    let refusal: string | undefined;
    try {
      await this.session.prompt(text);
    } catch (e) {
      refusal = messageOf(e);
    }
    this.announceOnceOnDisk();
    this.endTurn(turn, refusal ? "error" : "success", refusal);
  }

  // Pi's /compact is its terminal's own; prompt() would send it to the model as text.
  private async compact(turn: RunningTurn, instructions: string | undefined): Promise<void> {
    try {
      await this.session.compact(instructions);
      this.endTurn(turn, "success");
    } catch {
      this.endTurn(turn, turn.stopRequested ? "stopped" : "error");
    }
  }

  private async switchModel(turn: RunningTurn, command: "model" | "effort", input: string): Promise<void> {
    const { signal } = this.questions;
    const deps = {
      session: this.session,
      piProvider: this.asking.piProvider,
      ask: async (question: EngineQuestion["questions"][number]) => {
        const toolUseId = `${CONNECTOR_QUESTION_ID_PREFIX}${++this.ownQuestions}`;
        const answer = await this.asking.onQuestion({ toolUseId, questions: [question] }, signal);
        if (signal.aborted) throw new Error("stopped");
        return answer.response?.trim() || answer.answers[question.question] || "";
      },
    };
    try {
      const done = await (command === "model" ? chooseModel(deps, input) : chooseEffort(deps, input));
      if (done.modelChanged && this.session.model) {
        this.outbox.push({ type: "announce", model: this.session.model.id, permissionMode: PERMISSION_MODE });
      }
      this.outbox.push({ type: "status", text: done.status });
      this.endTurn(turn, "success");
    } catch (e) {
      if (turn.stopRequested || signal.aborted) this.endTurn(turn, "stopped");
      else this.endTurn(turn, "error", messageOf(e));
    }
  }

  private async clear(turn: RunningTurn): Promise<void> {
    const manager = this.session.sessionManager;
    const first = manager.getBranch().find((e) => e.type === "message" && e.message.role === "user");
    try {
      if (first) {
        await this.session.navigateTree(first.id);
        // Pi persists no leaf; a reopen resumes from the file's last entry, so the cleared point needs one.
        manager.appendCustomEntry("connector-clear");
      }
    } catch (e) {
      this.endTurn(turn, "error", messageOf(e));
      return;
    }
    this.outbox.push({ type: "status", text: "conversation cleared" });
    this.endTurn(turn, "success");
  }

  private async exportSession(turn: RunningTurn): Promise<void> {
    const fail = (reason: string) => {
      this.outbox.push({ type: "status", text: reason });
      this.endTurn(turn, "error", reason);
    };
    if (!this.onArchiveFile) return fail("this session can't hand files to the phone");
    const dir = await mkdtemp(join(tmpdir(), "pi-export-"));
    let failure: string | undefined;
    try {
      const path = await this.session.exportToHtml(join(dir, "session.html"));
      const outcome = await this.onArchiveFile({ toolUseId: `export-${randomUUID()}`, path }, this.questions.signal);
      if (!outcome.archived) failure = outcome.reason;
    } catch (e) {
      failure = messageOf(e);
    }
    await rm(dir, { recursive: true, force: true });
    if (turn.stopRequested) this.endTurn(turn, "stopped");
    else if (failure) fail(failure);
    else this.endTurn(turn, "success");
  }

  private localStatus(turn: RunningTurn, line: () => string): void {
    try {
      this.outbox.push({ type: "status", text: line() });
      this.endTurn(turn, "success");
    } catch (e) {
      this.endTurn(turn, "error", messageOf(e));
    }
  }

  private name(name: string): string {
    if (!name) throw new Error("/name needs a name, e.g. /name Fixing the build");
    this.session.setSessionName(name);
    return `session named ${name}`;
  }

  private async reload(turn: RunningTurn): Promise<void> {
    try {
      await this.session.reload();
    } catch (e) {
      this.endTurn(turn, "error", messageOf(e));
      return;
    }
    this.outbox.push({ type: "menu", ...menu(this.session) });
    this.outbox.push({ type: "status", text: "reloaded skills, prompt templates and context files" });
    this.endTurn(turn, "success");
  }

  private endTurn(turn: RunningTurn, outcome: TurnOutcome, error?: string): void {
    if (turn.ended) return;
    turn.ended = true;
    const contextPercentage = outcome === "success" ? this.contextPercentage() : undefined;
    this.outbox.push({
      type: "turn_ended",
      outcome,
      ...(outcome === "error" && error ? { errors: [error] } : {}),
      durationMs: Date.now() - turn.startedAt,
      ...(turn.usage ? { usage: turn.usage } : {}),
      ...(contextPercentage !== undefined ? { contextPercentage } : {}),
    });
  }

  /** Pi has no reading right after a compaction, until its next model call. */
  private contextPercentage(): number | undefined {
    const percent = this.session.getContextUsage()?.percent;
    return percent == null ? undefined : Math.round(percent);
  }

  /** Pi prices every call at list price, even on a subscription login, which pays nothing per call. */
  private addBilled(sum: EngineUsage | undefined, usage: Usage, provider: string | undefined): EngineUsage {
    const total = addUsage(sum, usage);
    const subscription = provider !== undefined && this.session.modelRuntime.isUsingSubscription(provider);
    if (!subscription) return total;
    const { costUsd: _, ...tokens } = total;
    return sum?.costUsd === undefined ? tokens : { ...tokens, costUsd: sum.costUsd };
  }

  private reportUnrun(cause: "command" | "steer", outcome: "stopped" | "error", error?: string): void {
    this.outbox.push({ type: "turn_started", cause });
    this.outbox.push({ type: "turn_ended", outcome, ...(error ? { errors: [error] } : {}), durationMs: 0 });
  }

  private announceOnceOnDisk(): void {
    const sessionFile = this.session.sessionFile;
    if (!this.unannounced || !sessionFile || !existsSync(sessionFile)) return;
    this.outbox.push(this.unannounced);
    this.unannounced = undefined;
  }

  private handle(event: AgentSessionEvent): void {
    const turn = this.turn;
    if (!turn || turn.ended) return;
    // Pi writes a message to disk only after emitting its message_end.
    this.announceOnceOnDisk();
    switch (event.type) {
      case "agent_start":
        if (turn.stopRequested) void this.session.abort();
        return;

      case "message_start":
        if (event.message.role !== "user") return;
        if (!turn.promptStarted || !this.steering) {
          turn.promptStarted = true;
          return;
        }
        this.steering = undefined;
        this.endTurn(turn, turn.modelError ? "error" : "success", turn.modelError);
        this.startTurn("steer").promptStarted = true;
        return;

      case "message_end": {
        const message = event.message;
        if (message.role === "toolResult" && message.usage) {
          turn.usage = this.addBilled(turn.usage, message.usage, this.session.model?.provider);
        }
        if (message.role !== "assistant") return;
        turn.usage = this.addBilled(turn.usage, message.usage, message.provider);
        for (const block of message.content) {
          if (block.type === "text" && block.text) this.outbox.push({ type: "assistant_text", text: block.text });
        }
        turn.modelError = message.stopReason === "error" ? (message.errorMessage ?? "the model call failed") : undefined;
        return;
      }

      case "tool_execution_start":
        if (event.toolName === QUESTION_TOOL) return;
        this.outbox.push({ type: "tool_use", toolUseId: event.toolCallId, name: event.toolName, input: event.args });
        return;

      case "tool_execution_end":
        if (event.toolName === QUESTION_TOOL) return;
        this.outbox.push({
          type: "tool_result",
          toolUseId: event.toolCallId,
          text: resultText(event.result),
          isError: event.isError,
        });
        return;

      case "compaction_start":
        this.outbox.push({ type: "compacting", trigger: event.reason === "manual" ? "manual" : "auto" });
        return;

      case "compaction_end": {
        if (event.errorMessage) this.outbox.push({ type: "status", text: event.errorMessage });
        const result = event.result;
        if (!result) return;
        if (result.usage) turn.usage = this.addBilled(turn.usage, result.usage, this.session.model?.provider);
        const contextPercentage = this.contextPercentage();
        this.outbox.push({
          type: "compacted",
          preTokens: result.tokensBefore,
          ...(result.estimatedTokensAfter !== undefined ? { postTokens: result.estimatedTokensAfter } : {}),
          ...(contextPercentage !== undefined ? { contextPercentage } : {}),
        });
        return;
      }

      case "agent_settled":
        // An aborted model call ends with stopReason "error", so only the settle tells a Stop from a failure.
        if (event.aborted) this.endTurn(turn, "stopped");
        else if (turn.modelError) this.endTurn(turn, "error", turn.modelError);
        else this.endTurn(turn, "success");
        return;
    }
  }
}

const LOCAL_COMMANDS: SkillInfo[] = [
  { name: "compact", description: "Compact the conversation", argumentHint: "[instructions]" },
  { name: "clear", description: "Clear conversation history", argumentHint: "" },
  { name: "model", description: "Switch the model", argumentHint: "[model] [effort]" },
  { name: "effort", description: "Set how hard the model reasons", argumentHint: "[level]" },
  { name: "session", description: "Show model, messages, tokens and context", argumentHint: "" },
  { name: "name", description: "Name this session", argumentHint: "<name>" },
  { name: "reload", description: "Reload skills, prompt templates and context files", argumentHint: "" },
  { name: "export", description: "Export the session as an HTML file", argumentHint: "" },
];

function menu(session: AgentSession): { skills: SkillInfo[]; localCommands: SkillInfo[] } {
  return {
    skills: [
      ...session.resourceLoader.getSkills().skills.map((skill) => ({
        name: `skill:${skill.name}`,
        description: skill.description,
        argumentHint: "",
      })),
      ...session.promptTemplates.map((template) => ({
        name: template.name,
        description: template.description,
        argumentHint: template.argumentHint ?? "",
      })),
    ],
    localCommands: LOCAL_COMMANDS,
  };
}

function sessionStatus(session: AgentSession): string {
  const stats = session.getSessionStats();
  const model = session.model;
  const parts = [
    `${model ? model.id : "no model"}, effort ${session.thinkingLevel}`,
    `${stats.totalMessages} messages`,
    `${stats.tokens.total} tokens`,
  ];
  const percent = stats.contextUsage?.percent;
  parts.push(percent == null ? "context unknown" : `context ${Math.round(percent)}%`);
  if (model && !session.modelRuntime.isUsingSubscription(model.provider)) parts.push(`$${stats.cost.toFixed(4)}`);
  parts.push(`conversation ${session.sessionId}`);
  return parts.join(" · ");
}

function addUsage(sum: EngineUsage | undefined, usage: Usage): EngineUsage {
  return {
    inputTokens: (sum?.inputTokens ?? 0) + usage.input,
    outputTokens: (sum?.outputTokens ?? 0) + usage.output,
    cacheReadTokens: (sum?.cacheReadTokens ?? 0) + usage.cacheRead,
    cacheWriteTokens: (sum?.cacheWriteTokens ?? 0) + usage.cacheWrite,
    costUsd: (sum?.costUsd ?? 0) + usage.cost.total,
  };
}

function resultText(result: unknown): string | undefined {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
  return text || undefined;
}
