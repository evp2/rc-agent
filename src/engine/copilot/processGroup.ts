import { execFileSync } from "node:child_process";

/**
 * Sends SIGTERM to the whole process group `pid` belongs to. Returns whether
 * a signal was sent.
 *
 * Copilot runs each detached shell as a group of its own, under a wrapper
 * that leads the group, and can't cancel one itself. Signalling the group
 * ends the command and anything it started. The connector's own group --
 * which the Copilot runtime shares -- is never signalled.
 */
export function killProcessGroupOf(pid: number): boolean {
  if (process.platform === "win32") return false;
  const group = processGroupOf(pid);
  if (group === undefined || group <= 1 || group === processGroupOf(process.pid)) return false;
  try {
    process.kill(-group, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function processGroupOf(pid: number): number | undefined {
  try {
    const group = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());
    return Number.isInteger(group) && group > 0 ? group : undefined;
  } catch {
    return undefined;
  }
}
