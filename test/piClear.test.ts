import assert from "node:assert/strict";
import { test } from "node:test";

import { type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";

import type { EngineAnswer, EngineEvent, EngineSession } from "../src/engine/types.ts";
import { piEngineOn } from "./piDoubles.ts";

type Pi = ReturnType<typeof piEngineOn>;

function openOptions(projectDir: string, resume?: string) {
  return {
    projectDir,
    onQuestion: () => new Promise<EngineAnswer>(() => undefined),
    ...(resume ? { resume } : {}),
  };
}

async function readTurns(session: EngineSession, count: number): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  let ended = 0;
  for await (const event of session.events) {
    events.push(event);
    if (event.type === "turn_ended" && ++ended === count) return events;
  }
  throw new Error(`event stream ended after ${JSON.stringify(events)}`);
}

async function runConnector(pi: Pi, resume: string | undefined, commands: string[]): Promise<EngineEvent[]> {
  const session = await pi.engine.open(openOptions(pi.projectDir, resume));
  for (const command of commands) session.send(command);
  const events = commands.length ? await readTurns(session, commands.length) : [];
  await session.close();
  for await (const event of session.events) events.push(event);
  return events;
}

function lastTurn(events: EngineEvent[]): EngineEvent[] {
  return events.slice(events.findLastIndex((e) => e.type === "turn_started"));
}

function conversationOf(events: EngineEvent[]): Extract<EngineEvent, { type: "conversation" }> | undefined {
  return events.find((e) => e.type === "conversation") as Extract<EngineEvent, { type: "conversation" }> | undefined;
}

function recording(reply = "noted") {
  const seen: string[][] = [];
  const step = (context: Context) => {
    seen.push(
      context.messages.map((m) =>
        typeof m.content === "string"
          ? m.content
          : m.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join(""),
      ),
    );
    return fauxAssistantMessage(reply);
  };
  return { steps: Array.from({ length: 10 }, () => step), seen };
}

test("PiEngine: /clear empties the Conversation in place, as a Turn of its own, keeping its id", async () => {
  const model = recording();
  const pi = piEngineOn(model.steps);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  session.send("the codeword is ZEBRA");
  session.send("/clear");
  session.send("what's the codeword?");
  const events = await readTurns(session, 3);
  await session.close();

  const clearTurn = events.slice(
    events.findIndex((e, i) => e.type === "turn_started" && events.slice(0, i).some((p) => p.type === "turn_ended")),
  );
  assert.deepEqual(
    clearTurn.slice(0, 3).map((e) => e.type),
    ["turn_started", "status", "turn_ended"],
  );
  assert.deepEqual(clearTurn[1], { type: "status", text: "conversation cleared" });
  assert.equal((clearTurn[2] as Extract<EngineEvent, { type: "turn_ended" }>).outcome, "success");
  assert.deepEqual(model.seen.at(-1)!.slice(0, -1), model.seen[0].slice(0, -1), "the model sees only what preceded the first message");
  assert.equal(model.seen.at(-1)!.at(-1), "what's the codeword?");
  assert.equal(events.filter((e) => e.type === "conversation").length, 1);
});

test("PiEngine: a Conversation /clear emptied is still empty after a connector restart", async () => {
  const model = recording();
  const pi = piEngineOn(model.steps);
  const first = conversationOf(await runConnector(pi, undefined, ["the codeword is ZEBRA", "/clear"]))!;

  const events = await runConnector(pi, first.id, ["what's the codeword?"]);
  assert.deepEqual(conversationOf(events), { type: "conversation", id: first.id, resumed: true });
  assert.deepEqual(model.seen.at(-1)!.slice(0, -1), model.seen[0].slice(0, -1));
  assert.equal(model.seen.at(-1)!.at(-1), "what's the codeword?");
});

test("PiEngine: /clear on a Conversation with no message yet has nothing to clear, and records nothing", async () => {
  const pi = piEngineOn([]);
  const events = await runConnector(pi, undefined, ["/clear"]);

  assert.deepEqual(
    lastTurn(events).map((e) => e.type),
    ["turn_started", "status", "turn_ended"],
  );
  assert.equal((lastTurn(events)[2] as Extract<EngineEvent, { type: "turn_ended" }>).outcome, "success");
  assert.equal(conversationOf(events), undefined, "a never-messaged Conversation isn't announced");
});
