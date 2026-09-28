import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

import { ENGINE_KINDS, type EngineKind } from "./engine/types";
import { isProcessAlive, readState } from "./state";

/**
 * One entry in the Worktree list: a git worktree sharing the attached
 * session's repository, live or not.
 * `controlUrl` is present only for a live, non-self entry -- there is nowhere
 * to switch to for a dead sibling, and switching to the self entry makes no
 * sense.
 */
export interface WorktreeEntry {
  path: string;
  /** The Engine of the session this entry stands for; absent for a worktree with no session state at all. */
  engine?: EngineKind;
  self: boolean;
  live: boolean;
  controlUrl?: string;
}

/**
 * Canonicalizes a path for comparison, falling back to the input when it no
 * longer exists on disk -- a worktree whose directory was removed by hand
 * still has a `git worktree list` entry but nothing left to resolve.
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
 * The Worktree list for the connector's periodic report: every session in
 * every sibling sharing `sourceWorktreePath`'s repository, live or not -- not
 * limited to direct Fork lineage. A worktree gets one entry per Engine that
 * has state there, or a single Engine-less entry when none has.
 *
 * Liveness is a local pid check against each session's own state file, never
 * corroborated against the relay's view of the session. Every sibling is on
 * this same machine, so holding siblings to a stricter check than the
 * connector applies to itself buys nothing: a session the relay Ended while
 * its connector is still up shows as live and fails softly when tapped.
 *
 * The self entry is this connector's own Engine in `sourceWorktreePath`,
 * looked up by that path itself rather than git's (possibly
 * realpath-canonicalized) rendering of it, since that is the exact path this
 * connector's own state file is keyed on.
 */
export function computeWorktreeList(sourceWorktreePath: string, selfEngine: EngineKind): WorktreeEntry[] {
  const selfCanonical = canonical(sourceWorktreePath);
  return listWorktreePaths(sourceWorktreePath).flatMap((path): WorktreeEntry[] => {
    const isSelfPath = canonical(path) === selfCanonical;
    const dir = isSelfPath ? sourceWorktreePath : path;
    const sessions = ENGINE_KINDS.flatMap((engine) => {
      const state = readState(dir, engine);
      return state ? [{ engine, state }] : [];
    });
    if (sessions.length === 0) return [{ path, self: isSelfPath, live: false }];
    return sessions.map(({ engine, state }) => {
      const self = isSelfPath && engine === selfEngine;
      const live = isProcessAlive(state.pid);
      return {
        path,
        engine,
        self,
        live,
        ...(!self && live && state.controlUrl ? { controlUrl: state.controlUrl } : {}),
      };
    });
  });
}
