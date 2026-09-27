import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import {
  CopilotClient,
  RuntimeConnection,
  type CopilotSession,
  type PermissionHandler,
  type SessionEvent,
} from "@github/copilot-sdk";

import type { CopilotProviderConfig } from "../../provider";
import { killProcessGroupOf } from "./processGroup";

/** One background task as Copilot lists it. Foreground shells are listed too. */
export interface CopilotTask {
  id: string;
  type: "shell" | "agent" | string;
  status: "running" | "idle" | "completed" | "failed" | "cancelled";
  description?: string;
  /** Shells only: `detached` survives the Turn that started it, `attached` does not. */
  attachmentMode?: "attached" | "detached";
  /** Agents only: the tool call that started it. */
  toolCallId?: string;
  /** `background` for work that runs on its own; `sync` for work the Turn waits on. */
  executionMode?: "sync" | "background";
  /** Shells only: a process in the shell's process group. */
  pid?: number;
}

/** What the adapter hands Copilot when it opens or resumes a session. */
export interface CopilotSessionOptions {
  model: string;
  workingDirectory: string;
  onPermissionRequest: PermissionHandler;
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
  send(prompt: string): Promise<void>;
  abort(): Promise<void>;
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
    return new SdkCopilotSession(await this.client.createSession(sdkSessionConfig(options)));
  }

  async resumeSession(id: string, options: CopilotSessionOptions): Promise<CopilotSessionHandle> {
    return new SdkCopilotSession(await this.client.resumeSession(id, sdkSessionConfig(options)));
  }

  async stop(): Promise<void> {
    await this.client.stop();
  }
}

function sdkSessionConfig(options: CopilotSessionOptions) {
  return {
    clientName: "rc-agent",
    model: options.model,
    workingDirectory: options.workingDirectory,
    onPermissionRequest: options.onPermissionRequest,
    // Loads the project's own Copilot configuration, its Skills included.
    enableConfigDiscovery: true,
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
