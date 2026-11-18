import assert from "node:assert/strict";
import { test } from "node:test";

import { type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";

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
