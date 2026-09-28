import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ConnectorConfig } from "../src/config.ts";
import { FakeEngine, sayAndFinish } from "../src/engine/fakeEngine.ts";
import type { Engine } from "../src/engine/types.ts";
import {
  ForkError,
  classifyForkFailure,
  executeForkPlan,
  planFork,
  readForkNameState,
  runFork,
  type SpawnConnector,
} from "../src/fork.ts";
import { takeForkedConversation } from "../src/spawn.ts";
import type { ConnectorState } from "../src/state.ts";

const baseConfig: ConnectorConfig = {
  relayBaseUrl: "http://relay.test",
  connectorCredential: "s",
  projectDir: "/home/dev/repo",
  provider: { type: "anthropic" },
};

test("planFork defaults fromRef to HEAD", () => {
  const plan = planFork({
    sourceWorktreePath: "/home/dev/repo",
    sourceConfig: baseConfig,
    name: "my-feature",
    fromRef: undefined,
  });
  assert.equal(plan.fromRef, "HEAD");
});

test("planFork uses an explicit fromRef", () => {
  const plan = planFork({
    sourceWorktreePath: "/home/dev/repo",
    sourceConfig: baseConfig,
    name: "my-feature",
    fromRef: "origin/main",
  });
  assert.equal(plan.fromRef, "origin/main");
});

test("planFork names the worktree as a sibling of the source, suffixed by name", () => {
  const plan = planFork({
    sourceWorktreePath: "/home/dev/repo",
    sourceConfig: baseConfig,
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
    name: "my-feature",
    fromRef: undefined,
  });
  assert.deepEqual(plan.configContents, {
    relayBaseUrl: "http://relay.test",
    connectorCredential: "s",
    projectDir: "",
    provider: { type: "anthropic" },
    inactivityCompact: { afterMinutes: 30 },
  });
});

test("planFork rejects an empty name", () => {
  assert.throws(() =>
    planFork({
      sourceWorktreePath: "/home/dev/repo",
      sourceConfig: baseConfig,
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

test("executeForkPlan lets git's own error propagate for a bad --from ref", () => {
  const repo = initRepo();
  const plan = planFork({
    sourceWorktreePath: repo,
    sourceConfig: baseConfig,
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
    name: "feature-e",
    fromRef: undefined,
  });

  executeForkPlan(plan, repo);
  assert.throws(() => executeForkPlan(plan, repo));
});

// --- classification, the domain rule from CONTEXT.md ---

function planFor(repo: string, name: string): ReturnType<typeof planFork> {
  return planFork({
    sourceWorktreePath: repo,
    sourceConfig: baseConfig,
    name,
    fromRef: undefined,
  });
}

test("classifyForkFailure calls an existing branch name_taken", () => {
  const repo = initRepo();
  execFileSync("git", ["branch", "taken-branch"], { cwd: repo });
  const plan = planFor(repo, "taken-branch");

  assert.equal(classifyForkFailure(plan, repo, readForkNameState(plan, repo)), "name_taken");
});

test("classifyForkFailure calls an existing worktree directory name_taken, with no branch of that name", () => {
  const repo = initRepo();
  const plan = planFor(repo, "taken-dir");
  mkdirSync(plan.worktreePath);

  assert.equal(classifyForkFailure(plan, repo, readForkNameState(plan, repo)), "name_taken");
});

test("classifyForkFailure calls a name git rejects as a ref invalid_name", () => {
  const repo = initRepo();
  const plan = planFor(repo, "fix login bug");

  assert.equal(classifyForkFailure(plan, repo, readForkNameState(plan, repo)), "invalid_name");
});

test("classifyForkFailure returns undefined for a failure that is neither", () => {
  const repo = initRepo();
  const plan = planFor(repo, "perfectly-fine");

  assert.equal(classifyForkFailure(plan, repo, readForkNameState(plan, repo)), undefined);
});

// `git worktree add` creates the branch and the directory, and the steps after
// it can still fail. Asking what exists *after* that would find the failed
// attempt's own leftovers and call a name that was free taken.
test("classifyForkFailure ignores a branch and directory the failed attempt created itself", () => {
  const repo = initRepo();
  const plan = planFor(repo, "half-done");
  const before = readForkNameState(plan, repo);

  executeForkPlan(plan, repo);

  assert.equal(classifyForkFailure(plan, repo, before), undefined);
});

test("runFork throws a ForkError carrying git's text unmodified and the code", async () => {
  const repo = initRepo();
  execFileSync("git", ["branch", "already-here"], { cwd: repo });

  const error = await runFork({ ...baseConfig, projectDir: repo }, fakeEngine(), undefined, "already-here", undefined).then(
    () => undefined,
    (e: unknown) => e,
  );

  assert.ok(error instanceof ForkError);
  assert.equal(error.code, "name_taken");
  assert.match(error.message, /already exists/);
});

// --- the Conversation carry, through the Engine ---

function fakeEngine(forkConversation?: Engine["forkConversation"]): Engine {
  return new FakeEngine({ handlerFor: () => sayAndFinish("ok"), ...(forkConversation ? { forkConversation } : {}) });
}

function recordingSpawn(): { spawn: SpawnConnector; calls: { projectDir: string; resumeConversation?: string }[] } {
  const calls: { projectDir: string; resumeConversation?: string }[] = [];
  const spawn: SpawnConnector = async (config, _configPath, options) => {
    calls.push({ projectDir: config.projectDir, resumeConversation: options?.resumeConversation });
    return { projectDir: config.projectDir } as ConnectorState;
  };
  return { spawn, calls };
}

test("runFork asks the Engine to carry the Conversation into the new worktree, and the forked connector resumes it", async () => {
  const repo = initRepo();
  const asked: Parameters<Engine["forkConversation"]>[0][] = [];
  const engine = fakeEngine(async (input) => {
    asked.push(input);
    return "conv-carried";
  });
  const { spawn, calls } = recordingSpawn();

  await runFork({ ...baseConfig, projectDir: repo }, engine, "conv-1", "carry", undefined, spawn);

  assert.deepEqual(asked, [{ conversationId: "conv-1", fromDir: repo, toDir: `${repo}.carry` }]);
  assert.deepEqual(calls, [{ projectDir: `${repo}.carry`, resumeConversation: "conv-carried" }]);
});

test("runFork with no Conversation yet asks the Engine for nothing, and the fork starts fresh", async () => {
  const repo = initRepo();
  let asked = false;
  const engine = fakeEngine(async () => {
    asked = true;
    return "unexpected";
  });
  const { spawn, calls } = recordingSpawn();

  await runFork({ ...baseConfig, projectDir: repo }, engine, undefined, "fresh", undefined, spawn);

  assert.equal(asked, false);
  assert.deepEqual(calls, [{ projectDir: `${repo}.fresh`, resumeConversation: undefined }]);
});

test("runFork starts the fork fresh when the Engine had nothing to carry", async () => {
  const repo = initRepo();
  const { spawn, calls } = recordingSpawn();

  await runFork({ ...baseConfig, projectDir: repo }, fakeEngine(async () => undefined), "conv-1", "nothing", undefined, spawn);

  assert.deepEqual(calls, [{ projectDir: `${repo}.nothing`, resumeConversation: undefined }]);
});

test("runFork reports an Engine that fails to carry the Conversation as a ForkError, without starting a connector", async () => {
  const repo = initRepo();
  const { spawn, calls } = recordingSpawn();
  const engine = fakeEngine(async () => {
    throw new Error("disk full");
  });

  const error = await runFork({ ...baseConfig, projectDir: repo }, engine, "conv-1", "broken", undefined, spawn).then(
    () => undefined,
    (e: unknown) => e,
  );

  assert.ok(error instanceof ForkError);
  assert.equal(error.message, "disk full");
  assert.deepEqual(calls, []);
});

test("runFork on an Engine that can't fork refuses as engine_unsupported, before any git command or process", async () => {
  const repo = initRepo();
  const branchesBefore = execFileSync("git", ["branch", "--list"], { cwd: repo, encoding: "utf-8" });
  const { spawn, calls } = recordingSpawn();
  let asked = false;
  const engine = new FakeEngine({
    kind: "copilot",
    capabilities: { steer: false, fork: false },
    handlerFor: () => sayAndFinish("ok"),
    forkConversation: async () => {
      asked = true;
      return "unexpected";
    },
  });
  // With git unreachable, any git command would fail with its own error
  // rather than the Engine's refusal.
  const path = process.env.PATH;
  process.env.PATH = "";
  let error: unknown;
  try {
    error = await runFork({ ...baseConfig, projectDir: repo }, engine, "conv-1", "nope", undefined, spawn).then(
      () => undefined,
      (e: unknown) => e,
    );
  } finally {
    process.env.PATH = path;
  }

  assert.ok(error instanceof ForkError);
  assert.equal(error.code, "engine_unsupported");
  assert.match(error.message, /isn't available for copilot sessions/);
  assert.equal(asked, false);
  assert.deepEqual(calls, []);
  assert.equal(existsSync(`${repo}.nope`), false);
  assert.equal(execFileSync("git", ["branch", "--list"], { cwd: repo, encoding: "utf-8" }), branchesBefore);
});

test("a Fork's carried Conversation reaches the spawned connector once, and goes no further", () => {
  process.env.CRC_FORKED_CONVERSATION = "conv-carried";

  assert.equal(takeForkedConversation(), "conv-carried");
  assert.equal(process.env.CRC_FORKED_CONVERSATION, undefined);
  assert.equal(takeForkedConversation(), undefined);
});
