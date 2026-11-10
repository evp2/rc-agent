import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { ensureStateDir, STATE_DIR } from "./state";

export interface HostIdentity {
  hostId: string;
  hostName: string;
}

const HOST_FILE = join(STATE_DIR, "host.json");

/**
 * The machine this connector runs on, as the relay groups sessions by it. The
 * id lives in the home-level state directory so every worktree, Engine and
 * credential on the machine shares it, and a rename changes only `hostName`.
 */
export function hostIdentity(): HostIdentity {
  return { hostId: readHostId() ?? writeHostId(), hostName: hostname() };
}

function readHostId(): string | undefined {
  try {
    const { hostId } = JSON.parse(readFileSync(HOST_FILE, "utf-8")) as { hostId?: unknown };
    return typeof hostId === "string" && hostId ? hostId : undefined;
  } catch {
    return undefined;
  }
}

function writeHostId(): string {
  ensureStateDir();
  const hostId = randomUUID();
  const tmp = `${HOST_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ hostId })}\n`, { mode: 0o600 });
  renameSync(tmp, HOST_FILE);
  return hostId;
}
