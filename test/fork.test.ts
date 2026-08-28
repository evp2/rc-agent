import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { ConnectorConfig } from "../src/config.ts";
import { encodeProjectPath, executeForkPlan, planFork, transcriptPath } from "../src/fork.ts";

const baseConfig: ConnectorConfig = {
  relayBaseUrl: "http://relay.test",
  createSecret: "s",
  projectDir: "/home/dev/repo",
  provider: { type: "anthropic" },
};

function projectsDir(): string {
  return mkdtempSync(join(tmpdir(), "crc-fork-projects-"));
}

test("encodeProjectPath replaces slashes and dots with dashes", () => {
  assert.equal(
    encodeProjectPath("/private/tmp/crc-encode-test.v1/sub.dir"),
    "-private-tmp-crc-encode-test-v1-sub-dir",
  );
});

test("planFork defaults fromRef to HEAD", () => {
  const plan = planFork({
    sourceWorktreePath: "/home/dev/repo",
    sourceConfig: baseConfig,
    sdkSessionId: undefined,
    name: "my-feature",
    fromRef: undefined,
  });
  assert.equal(plan.fromRef, "HEAD");
});

test("planFork uses an explicit fromRef", () => {
  const plan = planFork({
    sourceWorktreePath: "/home/dev/repo",
    sourceConfig: baseConfig,
    sdkSessionId: undefined,
    name: "my-feature",
    fromRef: "origin/main",
  });
  assert.equal(plan.fromRef, "origin/main");
});

test("planFork names the worktree as a sibling of the source, suffixed by name", () => {
  const plan = planFork({
    sourceWorktreePath: "/home/dev/repo",
    sourceConfig: baseConfig,
    sdkSessionId: undefined,
    name: "my-feature",
    fromRef: undefined,
  });
  assert.equal(plan.worktreePath, "/home/dev/repo.my-feature");
  assert.equal(plan.branchName, "my-feature");
});

test("planFork writes a config with the source's relay/provider settings and a blank projectDir", () => {
  const plan = planFork({
    sourceWorktreePath: "/home/dev/repo",
    sourceConfig: { ...baseConfig, inactivityCompact: { afterMinutes: 30 } },
    sdkSessionId: undefined,
    name: "my-feature",
    fromRef: undefined,
  });
  assert.deepEqual(plan.configContents, {
    relayBaseUrl: "http://relay.test",
    createSecret: "s",
    projectDir: "",
    provider: { type: "anthropic" },
    inactivityCompact: { afterMinutes: 30 },
  });
});

test("planFork omits a transcript plan when there is no sdkSessionId", () => {
  const plan = planFork({
    sourceWorktreePath: "/home/dev/repo",
    sourceConfig: baseConfig,
    sdkSessionId: undefined,
    name: "my-feature",
    fromRef: undefined,
  });
  assert.equal(plan.transcript, undefined);
});

test("planFork derives transcript source/dest paths from the cwd-encoding scheme", () => {
  const pd = projectsDir();
  const plan = planFork({
    sourceWorktreePath: "/home/dev/repo",
    sourceConfig: baseConfig,
    sdkSessionId: "abc-123",
    name: "my-feature",
    fromRef: undefined,
    claudeProjectsDir: pd,
  });
  assert.equal(plan.transcript?.sourcePath, join(pd, "-home-dev-repo", "abc-123.jsonl"));
  assert.equal(
    plan.transcript?.destPath,
    join(pd, "-home-dev-repo-my-feature", "abc-123.jsonl"),
  );
});

test("planFork rejects an empty name", () => {
  assert.throws(() =>
    planFork({
      sourceWorktreePath: "/home/dev/repo",
      sourceConfig: baseConfig,
      sdkSessionId: undefined,
      name: "  ",
      fromRef: undefined,
    }),
  );
});

// --- executor, against a real temporary git repo ---

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "crc-fork-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "file.txt"), "hi\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

test("executeForkPlan creates the worktree on the new branch and writes the config", () => {
  const repo = initRepo();
  const plan = planFork({
    sourceWorktreePath: repo,
    sourceConfig: baseConfig,
    sdkSessionId: undefined,
    name: "feature-a",
    fromRef: undefined,
  });

  executeForkPlan(plan, repo);

  assert.ok(existsSync(plan.worktreePath));
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: plan.worktreePath,
    encoding: "utf-8",
  }).trim();
  assert.equal(branch, "feature-a");

  const config = JSON.parse(
    readFileSync(join(plan.worktreePath, "connector.config.json"), "utf-8"),
  );
  assert.equal(config.relayBaseUrl, "http://relay.test");
  assert.equal(config.projectDir, "");
});

test("executeForkPlan copies the transcript file when one exists", () => {
  const repo = initRepo();
  const pd = projectsDir();
  const sdkSessionId = "abc-123";
  const sourcePath = transcriptPath(repo, sdkSessionId, pd);
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, '{"hello":"world"}\n');

  const plan = planFork({
    sourceWorktreePath: repo,
    sourceConfig: baseConfig,
    sdkSessionId,
    name: "feature-b",
    fromRef: undefined,
    claudeProjectsDir: pd,
  });

  executeForkPlan(plan, repo);

  assert.ok(plan.transcript);
  const copied = readFileSync(plan.transcript!.destPath, "utf-8");
  assert.equal(copied, '{"hello":"world"}\n');
});

test("executeForkPlan does not fail when the transcript file is missing", () => {
  const repo = initRepo();
  const pd = projectsDir();
  const plan = planFork({
    sourceWorktreePath: repo,
    sourceConfig: baseConfig,
    sdkSessionId: "does-not-exist",
    name: "feature-c",
    fromRef: undefined,
    claudeProjectsDir: pd,
  });

  assert.doesNotThrow(() => executeForkPlan(plan, repo));
  assert.ok(!existsSync(plan.transcript!.destPath));
});

test("executeForkPlan lets git's own error propagate for a bad --from ref", () => {
  const repo = initRepo();
  const plan = planFork({
    sourceWorktreePath: repo,
    sourceConfig: baseConfig,
    sdkSessionId: undefined,
    name: "feature-d",
    fromRef: "no-such-ref",
  });

  assert.throws(() => executeForkPlan(plan, repo));
});

test("executeForkPlan lets git's own error propagate for a branch name collision", () => {
  const repo = initRepo();
  const plan = planFork({
    sourceWorktreePath: repo,
    sourceConfig: baseConfig,
    sdkSessionId: undefined,
    name: "feature-e",
    fromRef: undefined,
  });

  executeForkPlan(plan, repo);
  assert.throws(() => executeForkPlan(plan, repo));
});
