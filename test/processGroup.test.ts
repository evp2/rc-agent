import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { killProcessGroupOf } from "../src/engine/copilot/processGroup.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("killProcessGroupOf ends every process in the group of the pid it's given, not just that one", { skip: process.platform === "win32" }, async () => {
  // A detached shell the way Copilot runs one: a group leader, with the
  // command -- and its own children -- under it.
  const leader = spawn("sh", ["-c", "sh -c 'sleep 30' & wait"], { detached: true, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
  const exited = new Promise((r) => leader.once("exit", r));

  assert.equal(killProcessGroupOf(leader.pid!), true);
  await exited;
  assert.equal(alive(-leader.pid!), false, "the whole group is gone");
});

test("killProcessGroupOf never signals the connector's own process group", { skip: process.platform === "win32" }, () => {
  assert.equal(killProcessGroupOf(process.pid), false);
});

test("killProcessGroupOf returns false for a process that no longer exists", { skip: process.platform === "win32" }, () => {
  assert.equal(killProcessGroupOf(2 ** 22 + 12345), false);
});
