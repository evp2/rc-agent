import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { EngineAnswer, EngineEvent } from "../src/engine/types.ts";
import { piEngineOn } from "./piDoubles.ts";

test("PiEngine: the codemode tool is offered from the first prompt and still after /clear", async () => {
  const offered: string[][] = [];
  const step = (context: Context) => {
    const added = (context.messages[0] as unknown as { toolsAdded?: { name: string }[] }).toolsAdded ?? [];
    offered.push([...(context.tools ?? []), ...added].map((t) => t.name));
    return fauxAssistantMessage("ok");
  };
  const pi = piEngineOn([step, step, step]);
  const session = await pi.engine.open({
    projectDir: pi.projectDir,
    onQuestion: () => new Promise<EngineAnswer>(() => undefined),
  });
  for (const text of ["hello", "/clear", "hello again"]) session.send(text);
  let ended = 0;
  const events: EngineEvent[] = [];
  for await (const event of session.events) {
    events.push(event);
    if (event.type === "turn_ended" && ++ended === 3) break;
  }
  await session.close();

  assert.equal(offered.length, 2);
  assert.ok(offered[0].includes("codemode"), `first prompt tools: ${offered[0].join(", ")}`);
  assert.ok(offered[1].includes("codemode"), `post-clear tools: ${offered[1].join(", ")}`);
  assert.deepEqual(offered[1], offered[0]);
});

test("PiEngine: the dispatch tools are added to the session's tools, which are otherwise unchanged", async () => {
  async function toolsOffered(extra: object): Promise<string[]> {
    let offered: string[] = [];
    const step = (context: Context) => {
      const added = (context.messages[0] as unknown as { toolsAdded?: { name: string }[] }).toolsAdded ?? [];
      offered = [...(context.tools ?? []), ...added].map((t) => t.name);
      return fauxAssistantMessage("ok");
    };
    const pi = piEngineOn([step]);
    const session = await pi.engine.open({
      projectDir: pi.projectDir,
      onQuestion: () => new Promise<EngineAnswer>(() => undefined),
      ...extra,
    });
    session.send("hello");
    for await (const event of session.events) if (event.type === "turn_ended") break;
    await session.close();
    return offered;
  }

  const without = await toolsOffered({});
  const withDispatch = await toolsOffered({
    onListSiblings: async () => ({ siblings: [] }),
    onSendDispatch: async () => ({ sent: true }),
  });

  assert.ok(without.includes("codemode"));
  assert.deepEqual(
    withDispatch.filter((n) => n !== "list_siblings" && n !== "send_dispatch"),
    without,
  );
  assert.deepEqual(
    withDispatch.filter((n) => !without.includes(n)).sort(),
    ["list_siblings", "send_dispatch"],
  );
});

test("PiEngine: the codemode tool survives /clear in a Conversation recorded before it was offered", async () => {
  const pi = piEngineOn([fauxAssistantMessage("hi")]);
  const first = await pi.engine.open({
    projectDir: pi.projectDir,
    onQuestion: () => new Promise<EngineAnswer>(() => undefined),
  });
  first.send("hello");
  let id: string | undefined;
  for await (const event of first.events) {
    if (event.type === "conversation") id = event.id;
    if (event.type === "turn_ended") break;
  }
  await first.close();

  const file = SessionManager.findById(pi.projectDir, id!)!;
  const withoutCodemode = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const entry = JSON.parse(line);
      const added = entry.message?.toolsAdded as { name: string }[] | undefined;
      if (entry.message?.role === "system" && added) {
        entry.message.toolsAdded = added.filter((tool) => tool.name !== "codemode");
      }
      return JSON.stringify(entry);
    });
  writeFileSync(file, `${withoutCodemode.join("\n")}\n`);

  let offered: string[] = [];
  pi.faux.setResponses([
    (context: Context) => {
      const tools = new Set(context.tools?.map((t) => t.name));
      for (const message of context.messages as unknown as { role: string; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] }[]) {
        if (message.role !== "system") continue;
        for (const t of message.toolsRemoved ?? []) tools.delete(t.name);
        for (const t of message.toolsAdded ?? []) tools.add(t.name);
      }
      offered = [...tools];
      return fauxAssistantMessage("ok");
    },
  ]);
  const resumed = await pi.engine.open({
    projectDir: pi.projectDir,
    onQuestion: () => new Promise<EngineAnswer>(() => undefined),
    resume: id!,
  });
  for (const text of ["/clear", "hello again"]) resumed.send(text);
  let ended = 0;
  for await (const event of resumed.events) if (event.type === "turn_ended" && ++ended === 2) break;
  await resumed.close();

  assert.ok(offered.includes("codemode"), `tools after /clear: ${offered.join(", ")}`);
});
