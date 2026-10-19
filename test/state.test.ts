import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The state directory lives under the home directory, fixed when the module
// loads -- so point HOME at a scratch directory first, then load it.
process.env.HOME = mkdtempSync(`${tmpdir()}/crc-state-home-`);
const { ensureStateDir, isReusableState, liveConnector, readState, statePath, writeState } = await import("../src/state.ts");

const projectDir = "/home/dev/repo";

function writeRaw(body: Record<string, unknown>, engine: "claude" | "copilot" = "claude"): void {
  ensureStateDir();
  writeFileSync(statePath(projectDir, engine), JSON.stringify(body));
}

/** Where a connector from before per-Engine state kept a worktree's state: named after the worktree alone. */
function worktreeOnlyStatePath(dir: string): string {
  const key = createHash("sha256").update(dir).digest("hex").slice(0, 12);
  return join(process.env.HOME!, ".claude-remote-control", `${key}.json`);
}

const base = {
  version: 1,
  projectDir,
  relayBaseUrl: "http://relay.test",
  sessionId: "sess",
  secret: "sec",
  phoneUrl: "http://relay.test/?s=sess",
  pid: 1,
  startedAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

test("a state file with only the old SDK-session key resumes its Conversation, and the next write uses the new key", () => {
  writeRaw({ ...base, sdkSessionId: "conv-old" });

  const state = readState(projectDir, "claude");
  assert.equal(state?.conversationId, "conv-old");

  writeState(state!);
  const onDisk = JSON.parse(readFileSync(statePath(projectDir, "claude"), "utf-8"));
  assert.equal(onDisk.conversationId, "conv-old");
  assert.equal("sdkSessionId" in onDisk, false);
});

test("a state file with the new key keeps it over a stale old one", () => {
  writeRaw({ ...base, conversationId: "conv-new", sdkSessionId: "conv-old", engine: "claude" });

  assert.equal(readState(projectDir, "claude")?.conversationId, "conv-new");
});

test("a state file written before the Engine kind was recorded was written by Claude", () => {
  writeRaw({ ...base });

  assert.equal(readState(projectDir, "claude")?.engine, "claude");
});

test("the Engine kind a state file records survives a round trip", () => {
  writeRaw({ ...base, engine: "copilot" }, "copilot");

  assert.equal(readState(projectDir, "copilot")?.engine, "copilot");
});

const config = { relayBaseUrl: "http://relay.test", projectDir };
const previous = { ...base, engine: "claude" as const };

test("a state file for the same relay, project directory and Engine is reused", () => {
  assert.equal(isReusableState(previous, config, "claude"), true);
});

test("a state file whose Engine kind differs from the config's is not reused", () => {
  assert.equal(isReusableState(previous, config, "copilot"), false);
});

test("a state file for a different relay or project directory is not reused", () => {
  assert.equal(isReusableState(previous, { ...config, relayBaseUrl: "http://other.test" }, "claude"), false);
  assert.equal(isReusableState(previous, { ...config, projectDir: "/elsewhere" }, "claude"), false);
});

test("no state file is not reused", () => {
  assert.equal(isReusableState(undefined, config, "claude"), false);
});

test("a Claude and a Copilot session in the same worktree each keep their own state", () => {
  const dir = "/home/dev/shared";
  writeState({ ...base, projectDir: dir, sessionId: "claude-sess", engine: "claude" });
  writeState({ ...base, projectDir: dir, sessionId: "copilot-sess", engine: "copilot" });

  assert.equal(readState(dir, "claude")?.sessionId, "claude-sess");
  assert.equal(readState(dir, "copilot")?.sessionId, "copilot-sess");
});

test("a live connector on one Engine is not live for the other Engine in the same worktree", () => {
  const dir = "/home/dev/live";
  writeState({ ...base, projectDir: dir, engine: "claude", pid: process.pid });

  assert.equal(liveConnector(dir, "claude")?.pid, process.pid);
  assert.equal(liveConnector(dir, "copilot"), undefined);
});

test("state named after the worktree alone is carried over to its own Engine", () => {
  const dir = "/home/dev/upgraded";
  ensureStateDir();
  writeFileSync(worktreeOnlyStatePath(dir), JSON.stringify({ ...base, projectDir: dir, sessionId: "kept", engine: "copilot" }));

  const state = readState(dir, "copilot");
  assert.equal(state?.sessionId, "kept");

  writeState(state!);
  assert.equal(existsSync(worktreeOnlyStatePath(dir)), false);
  assert.equal(readState(dir, "copilot")?.sessionId, "kept");
});

test("state named after the worktree alone is left in place for a different Engine", () => {
  const dir = "/home/dev/other-engine";
  ensureStateDir();
  writeFileSync(worktreeOnlyStatePath(dir), JSON.stringify({ ...base, projectDir: dir, sessionId: "claude-only" }));

  assert.equal(readState(dir, "copilot"), undefined);
  assert.equal(existsSync(worktreeOnlyStatePath(dir)), true);
  assert.equal(readState(dir, "claude")?.sessionId, "claude-only");
});
