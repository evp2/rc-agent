import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

import { computeWorktreeList } from "../src/worktrees.ts";
import { writeState } from "../src/state.ts";
import type { ConnectorState } from "../src/state.ts";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "crc-worktrees-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "file.txt"), "hi\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return realpathSync(dir);
}

function addSibling(repo: string, name: string): string {
  const path = join(dirname(repo), `${basename(repo)}.${name}`);
  execFileSync("git", ["worktree", "add", path, "-b", name], { cwd: repo });
  return path;
}

const baseState: Omit<ConnectorState, "projectDir" | "pid"> = {
  version: 1,
  relayBaseUrl: "http://relay.test",
  sessionId: "sess",
  secret: "sec",
  phoneUrl: "http://relay.test/?s=sess",
  engine: "claude",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

test("a worktree with no siblings reports a list containing only its own self entry", () => {
  const repo = initRepo();

  const list = computeWorktreeList(repo, "claude");

  assert.equal(list.length, 1);
  assert.equal(list[0].self, true);
  assert.equal(list[0].controlUrl, undefined);
});

test("a sibling with a live connector process is reported live and carries its controlUrl", () => {
  const repo = initRepo();
  const sibling = addSibling(repo, "feature-a");
  writeState({
    ...baseState,
    projectDir: sibling,
    pid: process.pid,
    controlUrl: "https://example.test/p/1234567890",
  });

  const list = computeWorktreeList(repo, "claude");

  const entry = list.find((e) => !e.self);
  assert.ok(entry);
  assert.equal(entry!.live, true);
  assert.equal(entry!.controlUrl, "https://example.test/p/1234567890");
});

test("a sibling with no state file is reported not live and carries no controlUrl", () => {
  const repo = initRepo();
  addSibling(repo, "feature-b");

  const list = computeWorktreeList(repo, "claude");

  const entry = list.find((e) => !e.self);
  assert.ok(entry);
  assert.equal(entry!.live, false);
  assert.equal(entry!.controlUrl, undefined);
  assert.equal(entry!.engine, undefined);
});

test("a sibling with a dead pid is reported not live and carries no controlUrl", () => {
  const repo = initRepo();
  const sibling = addSibling(repo, "feature-c");
  // Pid 0 is never a real process (see isProcessAlive), standing in for a
  // crashed connector without needing to actually kill anything.
  writeState({
    ...baseState,
    projectDir: sibling,
    pid: 0,
    controlUrl: "https://example.test/p/0000000000",
  });

  const list = computeWorktreeList(repo, "claude");

  const entry = list.find((e) => !e.self);
  assert.ok(entry);
  assert.equal(entry!.live, false);
  assert.equal(entry!.controlUrl, undefined);
});

test("the currently attached worktree's own entry is marked self and carries no controlUrl", () => {
  const repo = initRepo();
  addSibling(repo, "feature-d");
  writeState({
    ...baseState,
    projectDir: repo,
    pid: process.pid,
    controlUrl: "https://example.test/p/1111111111",
  });

  const list = computeWorktreeList(repo, "claude");

  const self = list.find((e) => e.self);
  assert.ok(self);
  assert.equal(self!.live, true);
  assert.equal(self!.controlUrl, undefined);
});

test("computeWorktreeList reports every sibling, not just direct Fork lineage", () => {
  const repo = initRepo();
  const a = addSibling(repo, "feature-a");
  addSibling(repo, "feature-b");

  // feature-b's sibling list (queried from a different worktree of the same
  // repository) still includes feature-a, even though neither forked the
  // other directly.
  const list = computeWorktreeList(a, "claude");

  assert.equal(list.length, 3);
  assert.ok(list.some((e) => e.path.endsWith(".feature-b")));
});

test("a worktree holding a Claude and a Copilot session reports one entry per session, each with its Engine", () => {
  const repo = initRepo();
  const sibling = addSibling(repo, "both");
  writeState({ ...baseState, projectDir: sibling, pid: process.pid, engine: "claude" });
  writeState({ ...baseState, projectDir: sibling, pid: 0, engine: "copilot" });

  const entries = computeWorktreeList(repo, "claude").filter((e) => e.path === sibling);

  assert.deepEqual(
    entries.map((e) => [e.engine, e.live]),
    [["claude", true], ["copilot", false]],
  );
});

test("the other Engine's live session in the attached worktree is a switchable entry, not self", () => {
  const repo = initRepo();
  writeState({ ...baseState, projectDir: repo, pid: process.pid, engine: "claude" });
  writeState({
    ...baseState,
    projectDir: repo,
    pid: process.pid,
    engine: "copilot",
    controlUrl: "https://example.test/p/2222222222",
  });

  const list = computeWorktreeList(repo, "claude");

  assert.equal(list.length, 2);
  const self = list.find((e) => e.self);
  assert.equal(self?.engine, "claude");
  const other = list.find((e) => !e.self);
  assert.equal(other?.engine, "copilot");
  assert.equal(other?.live, true);
  assert.equal(other?.controlUrl, "https://example.test/p/2222222222");
});
