import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { hangUntilStopped, sayAndFinish, startBackgroundTaskAndFinish } from "../src/engine/fakeEngine.ts";
import { reportTasksInterruptedByRestart } from "../src/session/loop.ts";
import { LOST_CONVERSATION_TEXT } from "../src/session/pump.ts";
import { runTurn } from "../src/session/turn.ts";
import { checkForSteer, checkKillRequest } from "../src/session/watchers.ts";
import { cmd, makeTurnHarness, until } from "./doubles.ts";

test("the Conversation id is persisted once the Engine reports it, so a restart resumes it", async () => {
  const h = await makeTurnHarness({ script: { conversationId: "conv-abc" } });

  await until(() => h.ctx.conversationId === "conv-abc");

  assert.ok(h.written.some((s) => s.conversationId === "conv-abc"));
  await h.close();
});

test("a resumed Conversation says nothing on the phone", async () => {
  const h = await makeTurnHarness({ resume: "conv-abc", script: { conversationId: "conv-abc" } });

  await runTurn(h.ctx, cmd("hello again"));

  assert.ok(!h.ctx.eventBuffer.some((e) => e.text === LOST_CONVERSATION_TEXT));
  await h.close();
});

test("a Conversation that could not be resumed produces a visible status line, and the fresh one is persisted", async () => {
  const h = await makeTurnHarness({ resume: "conv-gone", script: { freshConversationId: "conv-new" } });

  await runTurn(h.ctx, cmd("hello again"));

  const lost = h.ctx.eventBuffer.find((e) => e.text === LOST_CONVERSATION_TEXT);
  assert.equal(lost?.type, "status");
  assert.equal(h.ctx.state.conversationId, "conv-new");
  await h.close();
});

test("the session banner is announced once, not above every reply, and again when it changes", async () => {
  const h = await makeTurnHarness({ script: { announce: { model: "model-a", permissionMode: "bypassPermissions" } } });
  const banners = () => h.ctx.eventBuffer.filter((e) => e.text?.startsWith("session started"));

  await until(() => banners().length === 1);
  const again = { type: "announce", model: "model-a", permissionMode: "bypassPermissions" } as const;
  assert.equal(h.ctx.bannerFor(again), undefined, "the same banner is not repeated");
  assert.deepEqual(h.ctx.bannerFor({ ...again, model: "model-b" }), {
    type: "status",
    text: "session started (model model-b, permission bypassPermissions)",
  });
  await h.close();
});

test("the Engine's menu is published to the relay", async () => {
  const menu = {
    skills: [{ name: "grill-me", description: "Interview me", argumentHint: "" }],
    localCommands: [{ name: "compact", description: "Compact the conversation", argumentHint: "" }],
  };
  // The Worktree list rides the same report, so it needs a real repository to list.
  const repo = mkdtempSync(join(tmpdir(), "crc-pump-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const h = await makeTurnHarness({ projectDir: repo, script: { menu } });

  await until(() => h.relay.putSkillsCalls.length === 1);

  assert.deepEqual(h.relay.putSkillsCalls[0].skills, menu.skills);
  assert.deepEqual(h.relay.putSkillsCalls[0].localCommands, menu.localCommands);
  await h.close();
});

test("a Background task is tracked in the state file while it runs, for restart reporting", async () => {
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const h = await makeTurnHarness({
    handlerFor: () => startBackgroundTaskAndFinish("bg-1", settled, { toolUseId: "tool-1", description: "sleep 30" }),
  });

  await runTurn(h.ctx, cmd("start something long"));
  assert.deepEqual(h.ctx.state.runningTasks, [{ task_id: "bg-1", tool_use_id: "tool-1", description: "sleep 30" }]);

  settle();
  await until(() => h.ctx.state.runningTasks === undefined);
  const settledEvent = h.ctx.eventBuffer.find((e) => e.type === "background_task_settled");
  assert.equal(settledEvent?.task_id, "bg-1");
  assert.equal(settledEvent?.task_status, "completed");
  await h.close();
});

test("Background tasks a previous process died holding are reported interrupted, and the tray emptied", async () => {
  const h = await makeTurnHarness();

  reportTasksInterruptedByRestart(h.ctx, [
    { task_id: "bg-1", tool_use_id: "tool-1", description: "npm run dev" },
    { task_id: "bg-2" },
  ]);

  assert.deepEqual(h.ctx.eventBuffer, [
    {
      type: "background_task_settled",
      task_id: "bg-1",
      tool_use_id: "tool-1",
      task_status: "interrupted",
      text: "interrupted by connector restart: npm run dev",
    },
    {
      type: "background_task_settled",
      task_id: "bg-2",
      tool_use_id: undefined,
      task_status: "interrupted",
      text: "interrupted by connector restart",
    },
    { type: "background_tasks_changed", tasks: [] },
  ]);
  assert.equal(h.ctx.state.runningTasks, undefined);
  await h.close();
});

test("a Kill from the phone reaches the Engine session once, between Turns too", async () => {
  const h = await makeTurnHarness();
  const killed: string[] = [];
  const session = h.ctx.engineSession;
  (h.ctx as { engineSession: typeof session }).engineSession = {
    ...session,
    events: session.events,
    killTask: async (taskId) => {
      killed.push(taskId);
    },
  };
  h.relay.getSession = async () => ({ kill_task: { task_id: "bg-1", requested_at: "2026-01-01T00:00:00.000Z" } });

  await checkKillRequest(h.ctx);
  await checkKillRequest(h.ctx);

  assert.deepEqual(killed, ["bg-1"]);
  await h.close();
});

test("an Engine that can't Steer never has a Command Steered into it: it waits its turn", async () => {
  const h = await makeTurnHarness({ handlerFor: () => hangUntilStopped(), script: { capabilities: { steer: false } } });
  let polled = false;
  h.relay.pollCommands = async () => {
    polled = true;
    return [cmd("sent mid-Turn")];
  };

  const turn = runTurn(h.ctx, cmd("first"));
  await until(() => !!h.ctx.currentTurn?.running);
  await checkForSteer(h.ctx);
  h.ctx.currentTurn!.abortController.abort();
  await turn;

  assert.equal(polled, false, "left for the main loop to pick up once the Turn ends");
  await h.close();
});

test("a Turn the Engine starts on its own is reported, and holds no Command", async () => {
  const h = await makeTurnHarness({ handlerFor: () => sayAndFinish("picked the work back up") });

  h.session.triggerEngineTurn();
  await until(() => h.ctx.eventBuffer.some((e) => e.type === "turn_complete"));

  assert.ok(h.ctx.eventBuffer.some((e) => e.text === "picked the work back up"));
  assert.equal(h.ledger.snapshot(), undefined);
  assert.deepEqual(h.relay.reports, []);
  await h.close();
});
