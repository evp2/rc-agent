import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import {
  CopilotClient,
  RuntimeConnection,
  type ContextTier,
  type CopilotSession,
  type ModelInfo,
  type PermissionHandler,
  type SessionEvent,
  type Tool,
} from "@github/copilot-sdk";

import type { CopilotProviderConfig } from "../../provider";
import { killProcessGroupOf } from "./processGroup";

/** One background task as Copilot lists it. Foreground shells are listed too. */
export interface CopilotTask {
  id: string;
  type: "shell" | "agent" | string;
  status: "running" | "idle" | "completed" | "failed" | "cancelled";
  description?: string;
  /** Shells only: the command line, as the tool call that started the shell gave it. */
  command?: string;
  /** Shells only: `detached` survives the Turn that started it, `attached` does not. */
  attachmentMode?: "attached" | "detached";
  /** Agents only: the tool call that started it. */
  toolCallId?: string;
  /** `background` for work that runs on its own; `sync` for work the Turn waits on. */
  executionMode?: "sync" | "background";
  /** Shells only: a process in the shell's process group. */
  pid?: number;
}

/** One Local command or Skill command as Copilot lists it. */
export interface CopilotCommand {
  /** Without the leading slash. */
  name: string;
  aliases?: string[];
  description: string;
  /** `builtin` runs inside Copilot; `skill` is backed by a Skill; `client` is registered by an SDK client. */
  kind: "builtin" | "skill" | "client" | string;
  input?: { hint: string };
}

/** One Skill as Copilot lists it. */
export interface CopilotSkill {
  name: string;
  /** The slash command that invokes it, without the slash, when it differs from `name`. */
  commandName?: string;
  description: string;
  /** Where Copilot found it: `project`, `inherited`, `personal-copilot`, `builtin`, ... */
  source: string;
  userInvocable: boolean;
  enabled: boolean;
  path?: string;
  argumentHint?: string;
}

/**
 * What running a slash command returned. `text` is output to show; `agent-prompt`
 * is a prompt the client is to send the agent next; the rest are outcomes a
 * terminal UI would act on.
 */
export type CopilotCommandResult =
  | { kind: "text"; text: string; markdown?: boolean }
  | { kind: "agent-prompt"; prompt: string; displayPrompt?: string; notice?: string }
  | { kind: "completed"; message?: string }
  | { kind: "add-timeline-entry"; entry: { text: string } }
  | { kind: "select-subcommand"; command: string; title: string; options: { name: string; description?: string }[] }
  | { kind: "show-dialog" | "set-model" | "set-plan-model" };

/** Copilot's single question with optional choices, asked through its `ask_user` tool. */
export interface CopilotUserInputRequest {
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
}

export interface CopilotUserInputResponse {
  answer: string;
  wasFreeform: boolean;
}

/** What the adapter hands Copilot when it opens or resumes a session. */
export interface CopilotSessionOptions {
  model: string;
  workingDirectory: string;
  onPermissionRequest: PermissionHandler;
  /** Holds the Turn until the human answers. Rejecting fails the question tool. */
  onUserInputRequest: (request: CopilotUserInputRequest) => Promise<CopilotUserInputResponse>;
  /** The connector's own tools, run in this process when the model calls them. */
  tools?: Tool[];
  /** Effort and context tier from the developer's own Copilot settings. */
  reasoningEffort?: ReasoningEffort;
  contextTier?: ContextTier;
}

/**
 * The slice of a Copilot session the adapter drives. The real one wraps the
 * SDK's `CopilotSession`; tests replay recorded session events through a fake.
 */
export interface CopilotSessionHandle {
  readonly sessionId: string;
  /** Subscribes to every session event. Returns an unsubscribe function. */
  on(handler: (event: SessionEvent) => void): () => void;
  /** Called once if the runtime goes away underneath the session. */
  onDisconnected(handler: () => void): void;
  /** Hands Copilot a prompt; while a Turn runs, it waits in Copilot's own queue. */
  send(prompt: string): Promise<void>;
  abort(): Promise<void>;
  /**
   * Ends the running Turn and starts the next queued prompt in its place.
   * Resolves false when there was no Turn to interrupt.
   */
  interruptMainTurn(): Promise<boolean>;
  listCommands(): Promise<CopilotCommand[]>;
  listSkills(): Promise<CopilotSkill[]>;
  /** Runs a slash command. Rejects with Copilot's message, such as a usage line, when it refuses. */
  invokeCommand(name: string, input?: string): Promise<CopilotCommandResult>;
  listTasks(): Promise<CopilotTask[]>;
  cancelTask(id: string): Promise<void>;
  disconnect(): Promise<void>;
}

/** The slice of a Copilot runtime (one `CopilotClient`) the adapter drives. */
export interface CopilotRuntime {
  authStatus(): Promise<{ isAuthenticated: boolean; statusMessage?: string; login?: string }>;
  createSession(options: CopilotSessionOptions): Promise<CopilotSessionHandle>;
  /** Rejects when Copilot has no conversation with this id. */
  resumeSession(id: string, options: CopilotSessionOptions): Promise<CopilotSessionHandle>;
  stop(): Promise<void>;
}

/**
 * Which Copilot runtime a connector drives.
 *
 * By default that is the installed `copilot` CLI, because it is the one that
 * sees the developer's own `copilot login`: the SDK's bundled runtime was
 * observed reporting itself unauthenticated right after a successful login.
 * With `COPILOT_GITHUB_TOKEN` set, the bundled runtime runs on that token
 * instead, for machines where nobody can log in interactively.
 */
export type RuntimeChoice = { kind: "installed"; path: string } | { kind: "bundled"; token: string };

export function chooseRuntime(provider: CopilotProviderConfig, env: NodeJS.ProcessEnv = process.env): RuntimeChoice {
  const token = env.COPILOT_GITHUB_TOKEN;
  if (token) return { kind: "bundled", token };
  return { kind: "installed", path: resolveCliPath(provider.cliPath, env) };
}

/** Starts the runtime {@link chooseRuntime} picks. */
export async function startCopilotRuntime(
  provider: CopilotProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CopilotRuntime> {
  const choice = chooseRuntime(provider, env);
  const client =
    choice.kind === "bundled"
      ? new CopilotClient({ gitHubToken: choice.token, useLoggedInUser: false })
      : new CopilotClient({ connection: RuntimeConnection.forStdio({ path: choice.path }) });
  await client.start();
  return new SdkCopilotRuntime(client);
}

/**
 * The SDK checks that a runtime path exists rather than searching the PATH
 * for it, so a bare command name is resolved here, the way a shell would.
 */
export function resolveCliPath(cliPath: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const command = cliPath ?? "copilot";
  if (isAbsolute(command) || command.includes("/")) return resolve(command);
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Can't find the '${command}' executable on the PATH. Install the GitHub Copilot CLI, ` +
      `or set 'provider.cliPath' in the connector config.`,
  );
}

class SdkCopilotRuntime implements CopilotRuntime {
  constructor(private readonly client: CopilotClient) {}

  async authStatus() {
    return this.client.getAuthStatus();
  }

  async createSession(options: CopilotSessionOptions): Promise<CopilotSessionHandle> {
    const withSettings = { ...options, ...(await this.modelSettings(options.model)) };
    return new SdkCopilotSession(await this.client.createSession(sdkSessionConfig(withSettings)));
  }

  async resumeSession(id: string, options: CopilotSessionOptions): Promise<CopilotSessionHandle> {
    const withSettings = { ...options, ...(await this.modelSettings(options.model)) };
    return new SdkCopilotSession(await this.client.resumeSession(id, sdkSessionConfig(withSettings)));
  }

  /**
   * A session made through the SDK does not pick up `effortLevel` and
   * `contextTier` from the developer's settings.json, so they are read from
   * the runtime and passed in. The settings RPC is experimental and the model
   * list needs a login, so a failure of either just means no settings apply.
   */
  private async modelSettings(model: string): Promise<Pick<CopilotSessionOptions, "reasoningEffort" | "contextTier">> {
    try {
      const { settings } = await this.client.rpc.user.settings.get();
      const chosen = { effortLevel: settings.effortLevel?.value, contextTier: settings.contextTier?.value };
      const info = chosen.effortLevel == null ? undefined : (await this.client.listModels()).find((m) => m.id === model);
      return resolveModelSettings(chosen, info);
    } catch (e) {
      console.log(`Couldn't read Copilot's model settings: ${(e as Error).message}`);
      return {};
    }
  }

  async stop(): Promise<void> {
    await this.client.stop();
  }
}

type ReasoningEffort = NonNullable<ModelInfo["supportedReasoningEfforts"]>[number];

const CONTEXT_TIERS: readonly unknown[] = ["default", "long_context"];

/**
 * Narrows the developer's saved `effortLevel` and `contextTier` to what a
 * session can be given. Effort is dropped unless the model lists that level:
 * Copilot refuses to create a session that asks a model, `auto` included, for
 * an effort it doesn't support.
 */
export function resolveModelSettings(
  saved: { effortLevel?: unknown; contextTier?: unknown },
  model: Pick<ModelInfo, "supportedReasoningEfforts"> | undefined,
): Pick<CopilotSessionOptions, "reasoningEffort" | "contextTier"> {
  const effort = model?.supportedReasoningEfforts?.find((level) => level === saved.effortLevel);
  return {
    ...(effort ? { reasoningEffort: effort } : {}),
    ...(CONTEXT_TIERS.includes(saved.contextTier) ? { contextTier: saved.contextTier as ContextTier } : {}),
  };
}

export function sdkSessionConfig(options: CopilotSessionOptions) {
  return {
    clientName: "rc-agent",
    model: options.model,
    workingDirectory: options.workingDirectory,
    onPermissionRequest: options.onPermissionRequest,
    // Loads the project's own Copilot configuration, its Skills included.
    // Measured on CLI 1.0.88: that brings in the project's `.claude/skills`
    // and `.github/skills`, and `~/.copilot/skills`, but not `~/.claude/skills`.
    enableConfigDiscovery: true,
    // The single question with choices, which the phone's picker shows.
    askUserVariant: "legacy" as const,
    onUserInputRequest: options.onUserInputRequest,
    // JSON-schema forms have no picker on the phone. Declined, so whatever
    // asked can carry on without an answer rather than wait for one.
    onElicitationRequest: () => ({ action: "decline" as const }),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.contextTier ? { contextTier: options.contextTier } : {}),
  };
}

class SdkCopilotSession implements CopilotSessionHandle {
  constructor(private readonly session: CopilotSession) {}

  get sessionId(): string {
    return this.session.sessionId;
  }

  on(handler: (event: SessionEvent) => void): () => void {
    return this.session.on(handler);
  }

  onDisconnected(handler: () => void): void {
    // Internal to the SDK, and the only signal that the runtime process has
    // gone: a dead runtime otherwise just stops sending events. The SDK is
    // pinned exactly and the contract test covers this adapter, so a bump
    // that drops it is caught there.
    const internal = this.session as unknown as { _setOnDisconnected?: (cb: () => void) => void };
    internal._setOnDisconnected?.(handler);
  }

  async send(prompt: string): Promise<void> {
    await this.session.send({ prompt });
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  async interruptMainTurn(): Promise<boolean> {
    // Flushing keeps the prompt queued behind the Turn, which then runs next.
    const { interrupted } = await this.session.rpc.interruptMainTurn({ flushQueued: true });
    return interrupted;
  }

  async listCommands(): Promise<CopilotCommand[]> {
    const { commands } = await this.session.rpc.commands.list();
    return commands;
  }

  async listSkills(): Promise<CopilotSkill[]> {
    const { skills } = await this.session.rpc.skills.list();
    return skills;
  }

  async invokeCommand(name: string, input?: string): Promise<CopilotCommandResult> {
    return (await this.session.rpc.commands.invoke({ name, ...(input ? { input } : {}) })) as CopilotCommandResult;
  }

  async listTasks(): Promise<CopilotTask[]> {
    const { tasks } = await this.session.rpc.tasks.list();
    return tasks as CopilotTask[];
  }

  async cancelTask(id: string): Promise<void> {
    const { cancelled } = await this.session.rpc.tasks.cancel({ id });
    if (cancelled) return;
    // Copilot declines to cancel a detached shell (measured on CLI 1.0.88):
    // it reports `cancelled: false` and the shell runs to completion. Its
    // process group is signalled directly instead.
    const task = (await this.listTasks()).find((t) => t.id === id);
    if (task?.type === "shell" && task.attachmentMode === "detached" && task.status === "running" && task.pid) {
      killProcessGroupOf(task.pid);
    }
  }

  async disconnect(): Promise<void> {
    await this.session.disconnect();
  }
}
