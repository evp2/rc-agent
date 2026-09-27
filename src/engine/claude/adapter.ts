import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type {
  CanUseTool,
  HookInput,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  query as realQuery,
} from "@anthropic-ai/claude-agent-sdk";

import { PERMISSION_MODE } from "../../config";
import { transcriptPath } from "../../fork";
import { query as defaultSdkQuery } from "../../sdk/client";
import { AsyncQueue, userTextMessage } from "../../sdk/asyncQueue";
import { selectLocalCommands, selectSkills } from "../../skills";
import type {
  Engine,
  EngineEvent,
  EngineQuestion,
  EngineSession,
  EngineUsage,
  OpenOptions,
} from "../types";

export interface ClaudeEngineDeps {
  query: typeof realQuery;
  env: NodeJS.ProcessEnv;
}

/** Builds a Claude adapter wired to the real SDK's `query()`. */
export function createClaudeEngine(env: NodeJS.ProcessEnv): Engine {
  return new ClaudeEngine({ query: defaultSdkQuery, env });
}

/**
 * The SDK's own internal consistency-check tag, seen firing harmlessly around
 * a steered or aborted sub-turn -- never meant for a human to read, so it
 * must never surface as a Turn error.
 */
const EDE_DIAGNOSTIC_PREFIX = "[ede_diagnostic]";

function stringifyToolResultContent(content: unknown): string | undefined {
  if (content === undefined || content === null) return undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && "text" in block
          ? String((block as { text: unknown }).text)
          : JSON.stringify(block),
      )
      .join("\n");
  }
  return JSON.stringify(content);
}

type TurnEndedExtra = Partial<Omit<Extract<EngineEvent, { type: "turn_ended" }>, "type" | "durationMs">>;

/**
 * Wraps one query()-per-Turn-chain: a fresh `query()` starts a chain, a Steer
 * or a Command sent while that chain's query is still open streams into its
 * input instead of starting a new one, and the chain ends only once its
 * generator does (drained, aborted, or dead). Everything below this class is
 * SDK message shapes; everything above sees only neutral Engine events.
 */
class ClaudeEngineSession implements EngineSession {
  private readonly outbox = new AsyncQueue<EngineEvent>();
  /**
   * One entry per message pushed into an SDK input queue (the initial prompt,
   * a queued Command, or a Steer), consumed FIFO as each one's own
   * `system:init` arrives -- what tells the adapter whether a fresh Turn was
   * caused by a Command, a Steer, or the Engine itself. Cleared whenever the
   * chain that was consuming it ends: anything still queued there was never
   * delivered (the subprocess is gone), so it must not mislabel a later,
   * unrelated chain's first Turn.
   */
  private readonly pendingCauses: ("command" | "steer")[] = [];
  private readonly liveTaskIds = new Set<string>();
  /** Seeded from `options.resume`, so the very first query resumes it; replaced by whatever each `system:init` reports. */
  private conversationId: string | undefined;
  private announcedConversationId: string | undefined;
  private activeInput: AsyncQueue<SDKUserMessage> | undefined;
  private activeAbort: AbortController | undefined;
  private activeQueryHandle: Query | undefined;
  private turnRunning = false;
  private closed = false;
  private chainPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: ClaudeEngineDeps,
    private readonly options: OpenOptions,
  ) {
    this.conversationId = options.resume;
  }

  get events(): AsyncIterable<EngineEvent> {
    return this.outbox;
  }

  send(text: string): void {
    if (this.closed) return;
    this.pendingCauses.push("command");
    if (this.activeInput) this.activeInput.push(userTextMessage(text));
    else this.startChain(text);
  }

  steer(text: string): void {
    if (!this.turnRunning || !this.activeInput) throw new Error("no running Turn to Steer");
    this.pendingCauses.push("steer");
    this.activeInput.push(userTextMessage(text, { priority: "now" }));
  }

  stop(): void {
    this.activeAbort?.abort();
  }

  async killTask(taskId: string): Promise<void> {
    await this.activeQueryHandle?.stopTask(taskId).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.activeAbort?.abort();
    await this.chainPromise.catch(() => undefined);
    this.outbox.close();
  }

  private startChain(initialText: string): void {
    const input = new AsyncQueue<SDKUserMessage>();
    input.push(userTextMessage(initialText));
    this.activeInput = input;
    const abortController = new AbortController();
    this.activeAbort = abortController;

    const claudeOptions: Options = {
      // Without this the SDK sends a minimal system prompt that never states
      // the working directory, so a model asked for "a file named x.txt" has
      // nothing to resolve the name against.
      systemPrompt: { type: "preset", preset: "claude_code" },
      permissionMode: PERMISSION_MODE,
      allowDangerouslySkipPermissions: true,
      cwd: this.options.projectDir,
      env: this.deps.env,
      abortController,
      canUseTool: this.makeCanUseTool(),
      ...(this.conversationId ? { resume: this.conversationId } : {}),
      hooks: { PreCompact: [{ hooks: [this.makePreCompactHook()] }] },
    };

    const activeQuery = this.deps.query({ prompt: input, options: claudeOptions });
    this.activeQueryHandle = activeQuery;
    this.chainPromise = this.drain(activeQuery, abortController);
  }

  private makePreCompactHook(): (input: HookInput) => Promise<Record<string, never>> {
    return async (input) => {
      // `trigger: 'manual'` is a human's or Auto-compact's own already-expected
      // `/compact` -- not the involuntary case this reports.
      if (input.hook_event_name === "PreCompact" && input.trigger === "auto") {
        this.outbox.push({ type: "compacting", trigger: "auto" });
      }
      return {};
    };
  }

  private makeCanUseTool(): CanUseTool {
    return async (toolName, input, toolOpts) => {
      if (toolName !== "AskUserQuestion") return { behavior: "allow", updatedInput: input };
      const question: EngineQuestion = {
        toolUseId: toolOpts.toolUseID,
        questions: (input as { questions: EngineQuestion["questions"] }).questions,
      };
      try {
        const answer = await this.options.onQuestion(question, toolOpts.signal);
        return {
          behavior: "allow",
          updatedInput: { questions: question.questions, answers: answer.answers, response: answer.response },
        };
      } catch {
        return { behavior: "deny", message: "question not answered", interrupt: true };
      }
    };
  }

  private async readContextPercentage(activeQuery: Query): Promise<number | undefined> {
    try {
      const { percentage } = await activeQuery.getContextUsage();
      return Math.round(percentage);
    } catch (e) {
      console.error("Failed to get context usage:", (e as Error).message);
      return undefined;
    }
  }

  private async drain(activeQuery: Query, abortController: AbortController): Promise<void> {
    let turnStartedAt = Date.now();
    let turnStartedForCurrentSubturn = false;
    /** Set when the query died between Turns, for whatever was sent and never got to run. */
    let deathMessage: string | undefined;

    const ensureTurnStarted = (): void => {
      if (turnStartedForCurrentSubturn) return;
      turnStartedForCurrentSubturn = true;
      turnStartedAt = Date.now();
      this.turnRunning = true;
      this.outbox.push({ type: "turn_started", cause: this.pendingCauses.shift() ?? "engine" });
    };

    const endSubturn = (outcome: "success" | "error" | "stopped", extra: TurnEndedExtra = {}): void => {
      this.turnRunning = false;
      turnStartedForCurrentSubturn = false;
      this.outbox.push({ type: "turn_ended", outcome, durationMs: Date.now() - turnStartedAt, ...extra });
    };

    try {
      for await (const message of activeQuery) {
        // A Stop can land while the generator is mid-yield; bailing out here
        // bounds the drain by the signal regardless of what the generator
        // does further, and `for await`'s implicit `return()` call tells the
        // underlying query to stop too.
        if (abortController.signal.aborted) break;

        const isInit = message.type === "system" && message.subtype === "init";
        if (isInit && turnStartedForCurrentSubturn) {
          // A Steer's fresh init can land before the sub-turn it truncates
          // ever reports its own result -- the real SDK produces both
          // orderings. Close the old one out first so turn_ended always
          // precedes the next turn_started, regardless of which one this is.
          endSubturn("success");
        }
        if (isInit) {
          ensureTurnStarted();
          this.handleInit(message, activeQuery);
          continue;
        }

        // A message type this adapter doesn't translate at all (the real SDK
        // has plenty -- rate-limit notices, worker lifecycle, ...) must not
        // start a Turn for arriving. Otherwise one landing between two
        // Commands, or ahead of the very first Turn's own init, would be
        // read as a spurious Engine-started Turn, immediately closed out the
        // instant the real init followed it.
        if (!this.isRecognizedNonInit(message)) continue;

        // A Local command Steered in is answered by the CLI itself, inside
        // whatever Turn is running, with no fresh `init` to confirm it. Its
        // output is the first sign it was taken, so the Steer's Turn starts
        // here -- otherwise whoever Steered it waits on that Turn forever.
        if (
          turnStartedForCurrentSubturn &&
          this.pendingCauses[0] === "steer" &&
          message.type === "system" &&
          message.subtype === "local_command_output"
        ) {
          endSubturn("success");
        }
        ensureTurnStarted();
        if (this.translateNonInit(message)) continue;

        if (message.type === "system" && message.subtype === "compact_boundary") {
          const { pre_tokens, post_tokens } = message.compact_metadata;
          const contextPercentage = await this.readContextPercentage(activeQuery);
          this.outbox.push({ type: "compacted", preTokens: pre_tokens, postTokens: post_tokens, contextPercentage });
          continue;
        }

        if (message.type === "result") {
          const usage: EngineUsage = {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            cacheReadTokens: message.usage.cache_read_input_tokens,
            cacheWriteTokens: message.usage.cache_creation_input_tokens,
            costUsd: message.total_cost_usd,
          };
          if (message.subtype === "success") {
            const contextPercentage = await this.readContextPercentage(activeQuery);
            endSubturn("success", { usage, contextPercentage });
          } else {
            endSubturn("error", { usage, errors: message.errors.length ? message.errors : [message.subtype] });
          }
        }
      }
    } catch (e) {
      if (!abortController.signal.aborted) {
        const msg = (e as Error).message;
        console.error("Turn failed:", msg);
        // `[ede_diagnostic]` is the SDK's own internal consistency-check tag,
        // never meant for a human -- the Turn it fires around went on to
        // succeed.
        const diagnostic = msg.startsWith(EDE_DIAGNOSTIC_PREFIX);
        if (turnStartedForCurrentSubturn) {
          endSubturn(diagnostic ? "success" : "error", { errors: diagnostic ? undefined : [msg] });
        } else if (!diagnostic) {
          // Between Turns: the previous one already reported its outcome, so
          // this is only news to whatever was sent and never got to run --
          // reported below, against each of those.
          deathMessage = msg;
        }
      }
    } finally {
      if (abortController.signal.aborted) {
        // A Stop kills the whole subprocess, background children included,
        // with no further task_notification ever coming for them -- say so
        // ourselves, and before the Turn's own turn_ended, so a Stop's
        // effects on Background tasks are visible before the Turn it
        // stopped is reported over.
        for (const taskId of this.liveTaskIds) {
          this.outbox.push({ type: "task_settled", taskId, status: "stopped", ambient: false });
        }
        this.liveTaskIds.clear();
      }
      // The generator ended (drained or aborted) with a sub-turn still open
      // -- guarantee pairing rather than leave it stuck forever.
      if (turnStartedForCurrentSubturn) endSubturn(abortController.signal.aborted ? "stopped" : "success");

      // Anything still queued here was never delivered -- the subprocess
      // this chain drove is gone. Each one still gets a Turn that starts and
      // ends, so whoever sent it hears how it went instead of waiting for a
      // Turn that is never coming; and none of them may label a later
      // chain's Turn.
      for (const cause of this.pendingCauses.splice(0)) {
        this.outbox.push({ type: "turn_started", cause });
        if (abortController.signal.aborted) {
          this.outbox.push({ type: "turn_ended", outcome: "stopped", durationMs: 0 });
        } else if (cause === "steer" && deathMessage === undefined) {
          // The query ended cleanly with the Steer taken into the Turn it was
          // aimed at: absorbed, not failed.
          this.outbox.push({ type: "turn_ended", outcome: "success", durationMs: 0 });
        } else {
          this.outbox.push({
            type: "turn_ended",
            outcome: "error",
            errors: [deathMessage ?? "the agent's process ended before this could run"],
            durationMs: 0,
          });
        }
      }
      this.activeInput = undefined;
      this.activeAbort = undefined;
      this.activeQueryHandle = undefined;
    }
  }

  /** Everything a fresh `system:init` triggers, once the caller has already sequenced the Turn boundary around it. */
  private handleInit(message: Extract<SDKMessage, { type: "system"; subtype: "init" }>, activeQuery: Query): void {
    this.conversationId = message.session_id;
    if (this.announcedConversationId === undefined) {
      const requested = this.options.resume;
      const resumed = !!requested && requested === message.session_id;
      this.outbox.push({
        type: "conversation",
        id: message.session_id,
        resumed,
        ...(requested && !resumed ? { lostPrevious: true as const } : {}),
      });
    } else if (this.announcedConversationId !== message.session_id) {
      // A later query reported a different id for the same conversation --
      // whatever the connector persisted must follow it, or the next restart
      // resumes a stale one.
      this.outbox.push({ type: "conversation", id: message.session_id, resumed: true });
    }
    this.announcedConversationId = message.session_id;
    this.outbox.push({ type: "announce", model: message.model, permissionMode: message.permissionMode });

    const initSkillNames = message.skills;
    void activeQuery
      .supportedCommands()
      .then((commands) => {
        this.outbox.push({
          type: "menu",
          skills: selectSkills(commands, initSkillNames),
          localCommands: selectLocalCommands(commands, initSkillNames),
        });
      })
      .catch((e) => console.error("Failed to refresh the menu:", (e as Error).message));
  }

  /**
   * Whether a non-`init` message is one this adapter actually turns into
   * something -- content, a compaction, or a Turn's own outcome. Checked
   * before starting a Turn for a message at all, since the real SDK emits
   * message types with no per-Turn meaning (a `rate_limit_event`, a worker
   * lifecycle notice, ...) that must never be mistaken for one.
   */
  private isRecognizedNonInit(message: SDKMessage): boolean {
    if (message.type === "system") {
      return (
        message.subtype === "local_command_output" ||
        message.subtype === "task_started" ||
        message.subtype === "task_notification" ||
        message.subtype === "background_tasks_changed" ||
        message.subtype === "compact_boundary"
      );
    }
    return message.type === "conversation_reset" || message.type === "assistant" || message.type === "user" || message.type === "result";
  }

  /** Translates every message shape except `init`/`compact_boundary`/`result`, which the caller handles itself. Returns true when handled. */
  private translateNonInit(message: SDKMessage): boolean {
    if (message.type === "system" && message.subtype === "local_command_output") {
      this.outbox.push({ type: "status", text: message.content });
      return true;
    }
    if (message.type === "conversation_reset") {
      this.outbox.push({ type: "status", text: "conversation cleared" });
      return true;
    }
    if (message.type === "system" && message.subtype === "task_started") {
      this.liveTaskIds.add(message.task_id);
      this.outbox.push({
        type: "task_started",
        taskId: message.task_id,
        toolUseId: message.tool_use_id,
        description: message.description,
        taskType: message.task_type ?? (message.subagent_type ? "subagent" : undefined),
        ambient: !!message.skip_transcript,
      });
      return true;
    }
    if (message.type === "system" && message.subtype === "task_notification") {
      this.liveTaskIds.delete(message.task_id);
      this.outbox.push({
        type: "task_settled",
        taskId: message.task_id,
        toolUseId: message.tool_use_id,
        status: message.status,
        summary: message.summary,
        durationMs: message.usage?.duration_ms,
        ambient: !!message.skip_transcript,
      });
      return true;
    }
    if (message.type === "system" && message.subtype === "background_tasks_changed") {
      this.outbox.push({
        type: "tasks_changed",
        tasks: message.tasks.map((t) => ({ taskId: t.task_id, taskType: t.task_type, description: t.description })),
      });
      return true;
    }
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text" && block.text) {
          this.outbox.push({ type: "assistant_text", text: block.text });
        } else if (block.type === "tool_use" && block.name === "AskUserQuestion") {
          // No event for the Engine's own question tool -- `onQuestion` (via
          // canUseTool) is the only channel it reaches the connector by.
        } else if (block.type === "tool_use") {
          this.outbox.push({ type: "tool_use", toolUseId: block.id, name: block.name, input: block.input });
        }
      }
      return true;
    }
    if (message.type === "user") {
      const content = message.message.content;
      if (typeof content !== "string") {
        for (const block of content) {
          if (block.type === "tool_result") {
            this.outbox.push({
              type: "tool_result",
              toolUseId: block.tool_use_id,
              text: stringifyToolResultContent(block.content),
              isError: !!block.is_error,
            });
          }
        }
      }
      return true;
    }
    return false;
  }
}

/**
 * The Claude adapter: everything the Engine seam hides about the Claude
 * Agent SDK -- message shapes, how a Turn starts and ends, how a Steer is
 * delivered, resume, and Fork's transcript copy.
 */
export class ClaudeEngine implements Engine {
  readonly kind = "claude" as const;
  readonly capabilities = { steer: true };

  constructor(private readonly deps: ClaudeEngineDeps) {}

  async open(options: OpenOptions): Promise<EngineSession> {
    return new ClaudeEngineSession(this.deps, options);
  }

  async forkConversation(input: { conversationId: string; fromDir: string; toDir: string }): Promise<string | undefined> {
    const sourcePath = transcriptPath(input.fromDir, input.conversationId);
    if (!existsSync(sourcePath)) return undefined;
    const destPath = transcriptPath(input.toDir, input.conversationId);
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(sourcePath, destPath);
    return input.conversationId;
  }
}
