import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { ConnectorConfig } from "./config";
import { spawnDetached } from "./spawn";
import type { ConnectorState } from "./state";

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

/**
 * Why a Fork failed, when the reason is one a phone client can put into words
 * for a human. `name_taken` covers both halves of the domain rule -- the
 * branch exists, or the sibling worktree directory does -- because the remedy
 * for either is the same and the phone knows nothing about git. Anything
 * unrecognised stays uncoded and reaches the phone as git's own text.
 */
export type ForkErrorCode = "name_taken" | "invalid_name";

/**
 * A failed Fork. Carries git's own error text unmodified as its message, plus
 * a {@link ForkErrorCode} when the failure could be classified -- the code is
 * an *addition*, never a replacement, so nothing git said is reworded or lost
 * on the way to the phone.
 */
export class ForkError extends Error {
  constructor(
    message: string,
    readonly code: ForkErrorCode | undefined,
  ) {
    super(message);
    this.name = "ForkError";
  }
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

  const { relayBaseUrl, connectorCredential, provider, inactivityCompact } = input.sourceConfig;
  const configContents: Record<string, unknown> = {
    relayBaseUrl,
    connectorCredential,
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

/** True when `git` exits 0, false on any non-zero exit -- never throws. */
function gitSucceeds(args: string[], cwd: string): boolean {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** What a Fork name already pointed at, read before the attempt runs. */
export interface ForkNameState {
  branch: boolean;
  worktree: boolean;
}

/**
 * Reads what the Fork name already refers to. Must be called *before* the
 * attempt: `git worktree add` creates both the branch and the directory, and
 * the steps after it (writing the config, copying the transcript) can still
 * fail -- so asking afterwards would find a branch and a directory the failed
 * attempt made itself and call a free name taken.
 */
export function readForkNameState(plan: ForkPlan, sourceWorktreePath: string): ForkNameState {
  return {
    branch: gitSucceeds(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${plan.branchName}`],
      sourceWorktreePath,
    ),
    worktree: existsSync(plan.worktreePath),
  };
}

/**
 * Works out why a Fork failed, from what was there beforehand rather than
 * from what git said. Matching on git's stderr would mean depending on prose
 * that varies by git version and localises, in service of a field whose whole
 * purpose is to keep the phone client out of git's error grammar.
 *
 * It also makes the check and the definition the same code: a fork name is
 * taken when the branch or the directory exists, which is the rule stated in
 * CONTEXT.md, tested here rather than restated anywhere else.
 */
export function classifyForkFailure(
  plan: ForkPlan,
  sourceWorktreePath: string,
  before: ForkNameState,
): ForkErrorCode | undefined {
  if (before.branch || before.worktree) {
    return "name_taken";
  }

  // git's own validator, so ref syntax is never reimplemented here.
  if (!gitSucceeds(["check-ref-format", `refs/heads/${plan.branchName}`], sourceWorktreePath)) {
    return "invalid_name";
  }

  return undefined;
}

/**
 * Carries out a Fork end to end -- plans it, executes it against git and the
 * filesystem, then spawns and waits for the new Session's own connector
 * process -- and returns its published state, which is where the new
 * Session's Control URL lives. No printing: shared by the CLI's `fork()`
 * (cli/commands.ts, which prints for a human at a terminal) and the poll
 * loop's own handling of a `fork_request` (session/watchers.ts), which
 * reports the outcome as a transcript event instead. See
 * docs/specs/session-forking.md and .scratch/fork-from-chat-ui/spec.md.
 */
export async function runFork(
  config: ConnectorConfig,
  sdkSessionId: string | undefined,
  name: string,
  fromRef: string | undefined,
): Promise<ConnectorState> {
  const plan = planFork({
    sourceWorktreePath: config.projectDir,
    sourceConfig: config,
    sdkSessionId,
    name,
    fromRef,
  });

  const before = readForkNameState(plan, config.projectDir);
  try {
    executeForkPlan(plan, config.projectDir);
  } catch (e) {
    throw new ForkError((e as Error).message, classifyForkFailure(plan, config.projectDir, before));
  }

  const forkConfig: ConnectorConfig = { ...config, projectDir: plan.worktreePath };
  const forkConfigPath = join(plan.worktreePath, "connector.config.json");
  return spawnDetached(forkConfig, forkConfigPath);
}
