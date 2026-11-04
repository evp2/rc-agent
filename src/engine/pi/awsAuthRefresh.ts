import { spawn } from "node:child_process";

import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface CommandResult {
  /** Null when the command was killed by a signal or could not be started. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export type RunCommand = (argv: readonly string[], options: { timeoutMs: number }) => Promise<CommandResult>;

const AWS_AUTH_REFRESH_TIMEOUT_MS = 5 * 60_000;
export const RENEWAL_COOLDOWN_MS = 30_000;
const KILL_GRACE_MS = 5_000;
const STDERR_KEPT_CHARS = 64 * 1024;
const STDERR_LOGGED_CHARS = 2_000;

export const runCommand: RunCommand = (argv, { timeoutMs }) =>
  new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      resolve(result);
    };
    const [command, ...args] = argv;
    const child = spawn(command!, args, { stdio: ["ignore", "ignore", "pipe"], shell: false, windowsHide: true });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_KEPT_CHARS);
    });
    child.on("error", (e) => finish({ exitCode: null, signal: null, stderr: e.message }));
    child.on("close", (exitCode, signal) => finish({ exitCode, signal, stderr }));
    const termTimer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ exitCode: null, signal: "SIGKILL", stderr });
      }, KILL_GRACE_MS);
    }, timeoutMs);
  });

export interface CredentialRenewalDeps {
  run: RunCommand;
  now: () => number;
  reload: () => Promise<void>;
}

export class CredentialRenewal {
  constructor(
    private readonly argv: readonly string[],
    private readonly deps: CredentialRenewalDeps,
  ) {}

  private inFlight: Promise<boolean> | undefined;
  private last: { finishedAt: number; renewed: boolean } | undefined;

  // Inside the cooldown nothing runs and the call gets the last run's outcome, so a call sent on the old credentials is resent after a success.
  renew(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    if (this.last && this.deps.now() - this.last.finishedAt < RENEWAL_COOLDOWN_MS) {
      return Promise.resolve(this.last.renewed);
    }
    const run = this.run()
      .catch(() => false)
      .then((renewed) => {
        this.inFlight = undefined;
        this.last = { finishedAt: this.deps.now(), renewed };
        return renewed;
      });
    this.inFlight = run;
    return run;
  }

  private async run(): Promise<boolean> {
    const started = this.deps.now();
    const result = await this.deps
      .run(this.argv, { timeoutMs: AWS_AUTH_REFRESH_TIMEOUT_MS })
      .catch((e: unknown): CommandResult => ({ exitCode: null, signal: null, stderr: messageOf(e) }));
    if (result.exitCode === 0) {
      try {
        await this.deps.reload();
        return true;
      } catch (e) {
        console.error(`provider.awsAuthRefresh ran, but the AWS profile files could not be re-read: ${messageOf(e)}`);
        return false;
      }
    }
    const how =
      result.exitCode !== null
        ? `exited with status ${result.exitCode}`
        : result.signal
          ? `was stopped by ${result.signal}`
          : "could not be started";
    const tail = redactCredentials(result.stderr).slice(-STDERR_LOGGED_CHARS).trim();
    console.error(
      `provider.awsAuthRefresh ${how} after ${this.deps.now() - started}ms` + (tail ? `; stderr ends:\n${tail}` : ""),
    );
    return false;
  }
}

const REDACTED = "[redacted]";

function redactCredentials(text: string): string {
  return text
    .replace(/((?:secret|token|session|password|credential|key)[\w-]*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, `$1${REDACTED}`)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED)
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, REDACTED);
}

const AMAZON_BEDROCK = "amazon-bedrock";
const EXPIRED_TOKEN_NAME = /^ExpiredToken(Exception)?$/;
const EXPIRED_TOKEN_TEXT = /\bExpiredToken(Exception)?\b|security token included in the request is expired/i;

// pi-ai's Bedrock stream records the SDK's error name as a diagnostic only when it ends in "Exception".
function isExpiredCredentials(message: AssistantMessage): boolean {
  if (message.provider !== AMAZON_BEDROCK || message.stopReason !== "error") return false;
  const errorCode = message.diagnostics?.find((d) => d.type === "bedrock_response_failure")?.details?.errorCode;
  if (typeof errorCode === "string") return EXPIRED_TOKEN_NAME.test(errorCode);
  return EXPIRED_TOKEN_TEXT.test(message.errorMessage ?? "");
}

type StreamSimple = ModelRuntime["streamSimple"];

// Only an expiry before any output is resent, so the agent never sees half of one answer followed by another.
export function renewExpiredCredentials(runtime: Pick<ModelRuntime, "streamSimple">, renewal: CredentialRenewal): void {
  const send: StreamSimple = runtime.streamSimple.bind(runtime);
  // A virtual model's call re-enters streamSimple, so an error already resent once can pass through here again.
  const resent = new WeakSet<AssistantMessage>();
  runtime.streamSimple = (model, context, options) => {
    if (model.provider !== AMAZON_BEDROCK) return send(model, context, options);
    const outer = createAssistantMessageEventStream();
    const attempt = () => relayUnlessExpired(send(model, context, options), outer, resent);
    void (async () => {
      const expired = await attempt();
      if (!expired) return;
      if (options?.signal?.aborted || !(await renewal.renew())) {
        fail(outer, expired);
        return;
      }
      const again = await attempt();
      if (again) {
        resent.add(again);
        fail(outer, again);
      }
    })();
    return outer;
  };
}

function fail(outer: AssistantMessageEventStream, error: AssistantMessage): void {
  outer.push({ type: "error", reason: "error", error });
  outer.end(error);
}

async function relayUnlessExpired(
  inner: AssistantMessageEventStream,
  outer: AssistantMessageEventStream,
  resent: WeakSet<AssistantMessage>,
): Promise<AssistantMessage | undefined> {
  let held: AssistantMessageEvent | undefined;
  let forwarded = false;
  for await (const event of inner) {
    if (!forwarded && event.type === "start") {
      held = event;
      continue;
    }
    if (!forwarded && event.type === "error" && isExpiredCredentials(event.error) && !resent.has(event.error)) {
      return event.error;
    }
    forwarded = true;
    if (held) outer.push(held);
    held = undefined;
    outer.push(event);
  }
  if (held) outer.push(held);
  outer.end(await inner.result());
  return undefined;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
