import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { publishSkills } from "../src/session/commands.ts";
import { makeTurnHarness } from "./doubles.ts";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "crc-commands-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "file.txt"), "hi\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

test("publishSkills includes the computed Worktree list alongside skills and local commands", async () => {
  const repo = initRepo();
  const { ctx, relay } = makeTurnHarness([], { projectDir: repo });

  await publishSkills(ctx, [], []);

  assert.equal(relay.putSkillsCalls.length, 1);
  const { worktrees } = relay.putSkillsCalls[0];
  assert.equal(worktrees.length, 1);
  assert.equal(worktrees[0].self, true);
});

test("publishSkills skips the PUT when nothing -- including the Worktree list -- has changed", async () => {
  const repo = initRepo();
  const { ctx, relay } = makeTurnHarness([], { projectDir: repo });

  await publishSkills(ctx, [], []);
  await publishSkills(ctx, [], []);

  assert.equal(relay.putSkillsCalls.length, 1);
});

test("publishSkills re-publishes when the Worktree list changes even though skills didn't", async () => {
  const repo = initRepo();
  const { ctx, relay } = makeTurnHarness([], { projectDir: repo });

  await publishSkills(ctx, [], []);
  execFileSync("git", ["worktree", "add", `${repo}.sib`, "-b", "sib"], { cwd: repo });
  await publishSkills(ctx, [], []);

  assert.equal(relay.putSkillsCalls.length, 2);
  assert.equal(relay.putSkillsCalls[0].worktrees.length, 1);
  assert.equal(relay.putSkillsCalls[1].worktrees.length, 2);
});
