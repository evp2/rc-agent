import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Claude Code resumes a conversation by scanning
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, keyed by the
 * *invoking* directory, not just the session id -- confirmed empirically
 * against a real `claude` invocation. The encoding
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
  conversationId: string,
  claudeProjectsDir: string = defaultClaudeProjectsDir(),
): string {
  return join(claudeProjectsDir, encodeProjectPath(worktreePath), `${conversationId}.jsonl`);
}
