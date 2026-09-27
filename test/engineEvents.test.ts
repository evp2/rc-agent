import assert from "node:assert/strict";
import { test } from "node:test";

import { mapContentEvent } from "../src/session/engineEvents.ts";

test("a tool call and its result map to the relay's tool Events", () => {
  assert.deepEqual(mapContentEvent({ type: "tool_use", toolUseId: "t1", name: "Bash", input: { command: "ls" } }), [
    { type: "tool_use", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" },
  ]);
  assert.deepEqual(mapContentEvent({ type: "tool_result", toolUseId: "t1", text: "a.txt", isError: false }), [
    { type: "tool_result", tool_use_id: "t1", text: "a.txt", is_error: false },
  ]);
});

test("Background-task events map to the phone's card and tray Events", () => {
  assert.deepEqual(
    mapContentEvent({
      type: "task_started",
      taskId: "bg-1",
      toolUseId: "t1",
      description: "npm run dev",
      taskType: "shell",
      ambient: false,
    }),
    [
      {
        type: "background_task_started",
        task_id: "bg-1",
        tool_use_id: "t1",
        text: "npm run dev",
        task_type: "shell",
        is_ambient: false,
      },
    ],
  );
  assert.deepEqual(
    mapContentEvent({ type: "tasks_changed", tasks: [{ taskId: "bg-1", taskType: "shell", description: "npm run dev" }] }),
    [{ type: "background_tasks_changed", tasks: [{ task_id: "bg-1", task_type: "shell", description: "npm run dev" }] }],
  );
});

test("a compaction reads the same whether or not the Engine knows the size afterwards", () => {
  assert.equal(mapContentEvent({ type: "compacted", preTokens: 100 })[0].text, "compacted (from 100 tokens)");
  assert.equal(mapContentEvent({ type: "compacted", preTokens: 100, postTokens: 20 })[0].text, "compacted (100 → 20 tokens)");
  assert.equal(mapContentEvent({ type: "compacted" })[0].text, "compacted");
});

test("empty assistant text produces nothing", () => {
  assert.deepEqual(mapContentEvent({ type: "assistant_text", text: "" }), []);
});
