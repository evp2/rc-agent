import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";

// The state directory lives under the home directory, fixed when the module
// loads -- so point HOME at a scratch directory first, then load it.
process.env.HOME = mkdtempSync(`${tmpdir()}/crc-state-home-`);
const { ensureStateDir, isReusableState, readState, statePath, writeState } = await import("../src/state.ts");

const projectDir = "/home/dev/repo";

function writeRaw(body: Record<string, unknown>): void {
  ensureStateDir();
  writeFileSync(statePath(projectDir), JSON.stringify(body));
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

  const state = readState(projectDir);
  assert.equal(state?.conversationId, "conv-old");

  writeState(state!);
  const onDisk = JSON.parse(readFileSync(statePath(projectDir), "utf-8"));
  assert.equal(onDisk.conversationId, "conv-old");
  assert.equal("sdkSessionId" in onDisk, false);
});

test("a state file with the new key keeps it over a stale old one", () => {
  writeRaw({ ...base, conversationId: "conv-new", sdkSessionId: "conv-old", engine: "claude" });

  assert.equal(readState(projectDir)?.conversationId, "conv-new");
});

test("a state file written before the Engine kind was recorded was written by Claude", () => {
  writeRaw({ ...base });

  assert.equal(readState(projectDir)?.engine, "claude");
});

test("the Engine kind a state file records survives a round trip", () => {
  writeRaw({ ...base, engine: "copilot" });

  assert.equal(readState(projectDir)?.engine, "copilot");
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
