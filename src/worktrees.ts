import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

import { liveConnector } from "./state";

/**
 * One entry in the Worktree list (see CONTEXT.md and
 * docs/adr/0029-a-worktree-list-entry-reuses-its-siblings-control-credential.md):
 * a git worktree sharing the attached session's repository, live or not.
 * `controlUrl` is present only for a live, non-self entry -- there is nowhere
 * to switch to for a dead sibling, and switching to the self entry makes no
 * sense.
 */
export interface WorktreeEntry {
  path: string;
  self: boolean;
  live: boolean;
  controlUrl?: string;
}

/**
 * Canonicalizes a path for comparison, falling back to the input when it no
 * longer exists on disk -- a worktree whose directory was removed by hand
 * still has a `git worktree list` entry (see ADR 0029) but nothing left to
 * resolve.
 */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Every worktree git considers a sibling of `sourceWorktreePath`'s
 * repository, itself included, in whatever order `git worktree list`
 * reports them. Git resolves each path to its physical (symlink-free) form
 * regardless of how it was originally created, which is why every comparison
 * against these paths elsewhere in this module goes through {@link canonical}.
 */
export function listWorktreePaths(sourceWorktreePath: string): string[] {
  const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: sourceWorktreePath,
    encoding: "utf-8",
  });
  return output
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
}

/**
 * The Worktree list for the connector's periodic report: every sibling
 * sharing `sourceWorktreePath`'s repository, live or not -- not limited to
 * direct Fork lineage. Liveness is decided exactly the way {@link
 * liveConnector} already decides it for the attached connector on itself: a
 * local pid check against that sibling's own state file, never corroborated
 * against the relay's view of the session (ADR 0029).
 *
 * The self entry is looked up by `sourceWorktreePath` itself, not by git's
 * (possibly realpath-canonicalized) rendering of it, since that is the exact
 * path this connector's own state file is keyed on.
 */
export function computeWorktreeList(sourceWorktreePath: string): WorktreeEntry[] {
  const selfCanonical = canonical(sourceWorktreePath);
  return listWorktreePaths(sourceWorktreePath).map((path) => {
    const self = canonical(path) === selfCanonical;
    const state = self ? liveConnector(sourceWorktreePath) : liveConnector(path);
    return {
      path,
      self,
      live: state !== undefined,
      ...(!self && state?.controlUrl ? { controlUrl: state.controlUrl } : {}),
    };
  });
}
