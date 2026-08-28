import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { ConnectorConfig } from "./config";

/**
 * Claude Code resumes a conversation by scanning
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, keyed by the
 * *invoking* directory, not just the session id -- confirmed empirically
 * against a real `claude` invocation (see docs/adr/0001). The encoding
 * replaces every `/` and `.` in the absolute path with `-`.
 */
export function defaultClaudeProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

export function encodeProjectPath(absPath: string): string {
  return absPath.replace(/[/.]/g, "-");
}

export function transcriptPath(
  worktreePath: string,
  sdkSessionId: string,
  claudeProjectsDir: string = defaultClaudeProjectsDir(),
): string {
  return join(claudeProjectsDir, encodeProjectPath(worktreePath), `${sdkSessionId}.jsonl`);
}

export interface ForkPlan {
  worktreePath: string;
  branchName: string;
  fromRef: string;
  /** Contents to write as the new Worktree's `connector.config.json`. */
  configContents: Record<string, unknown>;
  /** Absent when the source Session has no `sdkSessionId` yet -- the fork starts fresh. */
  transcript?: { sourcePath: string; destPath: string };
}

export interface PlanForkInput {
  sourceWorktreePath: string;
  sourceConfig: ConnectorConfig;
  sdkSessionId: string | undefined;
  name: string;
  fromRef: string | undefined;
  /** Override for tests; production callers always use {@link defaultClaudeProjectsDir}. */
  claudeProjectsDir?: string;
}

/**
 * Derives everything a Fork needs -- the sibling worktree path, branch name,
 * transcript source/dest paths, and the new Session's config -- with no I/O,
 * so every naming decision is covered by plain unit tests. See
 * docs/specs/session-forking.md.
 */
export function planFork(input: PlanForkInput): ForkPlan {
  const name = input.name.trim();
  if (!name) throw new Error("Fork name must not be empty.");

  const worktreePath = join(
    dirname(input.sourceWorktreePath),
    `${basename(input.sourceWorktreePath)}.${name}`,
  );

  const { relayBaseUrl, createSecret, provider, inactivityCompact } = input.sourceConfig;
  const configContents: Record<string, unknown> = {
    relayBaseUrl,
    createSecret,
    projectDir: "",
    provider,
    ...(inactivityCompact ? { inactivityCompact } : {}),
  };

  return {
    worktreePath,
    branchName: name,
    fromRef: input.fromRef?.trim() || "HEAD",
    configContents,
    transcript: input.sdkSessionId
      ? {
          sourcePath: transcriptPath(input.sourceWorktreePath, input.sdkSessionId, input.claudeProjectsDir),
          destPath: transcriptPath(worktreePath, input.sdkSessionId, input.claudeProjectsDir),
        }
      : undefined,
  };
}

/**
 * Carries out a Fork plan against real git and the filesystem: creates the
 * worktree on the new branch, writes its config, and copies the transcript
 * when one is planned. Errors from `git` itself (bad ref, name collision,
 * branch checked out elsewhere) propagate unmodified -- no rewording, no
 * partial cleanup, since `git worktree add` fails atomically before creating
 * anything.
 */
export function executeForkPlan(plan: ForkPlan, sourceWorktreePath: string): void {
  execFileSync("git", ["worktree", "add", plan.worktreePath, "-b", plan.branchName, plan.fromRef], {
    cwd: sourceWorktreePath,
  });

  writeFileSync(
    join(plan.worktreePath, "connector.config.json"),
    `${JSON.stringify(plan.configContents, null, 2)}\n`,
  );

  if (plan.transcript) {
    if (existsSync(plan.transcript.sourcePath)) {
      mkdirSync(dirname(plan.transcript.destPath), { recursive: true });
      copyFileSync(plan.transcript.sourcePath, plan.transcript.destPath);
    } else {
      console.warn(
        `Note: no transcript found at ${plan.transcript.sourcePath} -- ` +
          `the fork will start a fresh conversation.`,
      );
    }
  }
}
