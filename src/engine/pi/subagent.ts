import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Usage } from "@earendil-works/pi-ai";

import type { SubagentProfiles } from "../../provider";

export interface SubagentCommand {
  command: string;
  args: string[];
}

export interface SubagentSettings {
  model: string;
  thinking: string;
}

const RESULT_CHARS = 8000;

export function subagentSettings(
  parent: SubagentSettings,
  profiles: SubagentProfiles | undefined,
  profile?: string,
): SubagentSettings | { error: string } {
  const chosen = profile === undefined ? profiles?.default : profiles?.profiles?.[profile];
  if (profile !== undefined && !chosen) {
    const names = Object.keys(profiles?.profiles ?? {});
    return { error: `There is no subagent profile '${profile}'. Available: ${names.join(", ") || "none"}.` };
  }
  return { model: chosen?.model ?? parent.model, thinking: chosen?.thinkingLevel ?? parent.thinking };
}

export function installedPi(): SubagentCommand {
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return { command: process.execPath, args: [join(dirname(entry), "bundle", "cli.js")] };
}

export function subagentArgs(base: SubagentCommand, settings: SubagentSettings): string[] {
  return [
    ...base.args,
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-mcp",
    "--tools",
    "read,bash,edit,write",
    "--model",
    settings.model,
    "--thinking",
    settings.thinking,
  ];
}

export function noUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function plus(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

interface ChildMessage {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  usage?: Usage;
}

export class ChildStream {
  usage: Usage = noUsage();
  private pending = "";
  private last: ChildMessage | undefined;

  feed(chunk: string): void {
    this.pending += chunk;
    for (let end = this.pending.indexOf("\n"); end >= 0; end = this.pending.indexOf("\n")) {
      this.line(this.pending.slice(0, end));
      this.pending = this.pending.slice(end + 1);
    }
  }

  finish(): void {
    if (this.pending) this.line(this.pending);
    this.pending = "";
  }

  get finalText(): string {
    const content = this.last?.content;
    if (!Array.isArray(content)) return "";
    const text = content
      .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("")
      .trim();
    return text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}...` : text;
  }

  get error(): string | undefined {
    const { stopReason, errorMessage } = this.last ?? {};
    if (stopReason === "error") return errorMessage ?? "the model call failed";
    if (stopReason === "aborted") return errorMessage ?? "the run was aborted";
    return undefined;
  }

  private line(line: string): void {
    let event: { type?: string; message?: ChildMessage };
    try {
      event = JSON.parse(line.trim());
    } catch {
      return;
    }
    if (event.type !== "message_end" || event.message?.role !== "assistant") return;
    this.last = event.message;
    if (event.message.usage) this.usage = plus(this.usage, event.message.usage);
  }
}
