import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { EngineAnswer, EngineEvent, EngineSession } from "../src/engine/types.ts";
import { piEngineOn } from "./piDoubles.ts";

function openOptions(projectDir: string) {
  return { projectDir, onQuestion: () => new Promise<EngineAnswer>(() => undefined) };
}

async function turnEvents(session: EngineSession, count: number): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  let ended = 0;
  for await (const event of session.events) {
    events.push(event);
    if (event.type === "turn_ended" && ++ended === count) return events;
  }
  throw new Error("event stream ended");
}

function lastTurn(events: EngineEvent[]): EngineEvent[] {
  return events.slice(events.findLastIndex((e) => e.type === "turn_started"));
}

test("PiEngine: /session is one status line with model, effort, messages, tokens, context and Conversation id", async () => {
  const pi = piEngineOn([() => fauxAssistantMessage("hello")]);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  session.send("hi");
  session.send("/session");
  const events = await turnEvents(session, 2);
  await session.close();

  const turn = lastTurn(events);
  assert.deepEqual(
    turn.map((e) => e.type),
    ["turn_started", "status", "turn_ended"],
  );
  const id = (events.find((e) => e.type === "conversation") as { id: string }).id;
  const text = (turn[1] as { text: string }).text;
  assert.match(text, /faux-model/);
  assert.match(text, /\d+ messages/);
  assert.match(text, /\d+ tokens/);
  assert.match(text, /context \d+%/);
  assert.ok(text.includes(id));
});

test("PiEngine: /session on a login billed per call shows dollars", async () => {
  const pi = piEngineOn([() => fauxAssistantMessage("hello")]);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  session.send("hi");
  session.send("/session");
  const events = await turnEvents(session, 2);
  await session.close();
  const text = (lastTurn(events)[1] as { text: string }).text;
  assert.ok(pi.runtime().isUsingSubscription("anthropic") === false);
  assert.match(text, /\$\d/);
});

test("PiEngine: /session on a subscription login shows no dollars", async () => {
  const pi = piEngineOn([() => fauxAssistantMessage("hello")], { subscription: true });
  const session = await pi.engine.open(openOptions(pi.projectDir));
  session.send("hi");
  session.send("/session");
  const events = await turnEvents(session, 2);
  await session.close();
  const text = (lastTurn(events)[1] as { text: string }).text;
  assert.doesNotMatch(text, /\$/);
});

test("PiEngine: /name names the session in Pi's file and sends nothing to the model", async () => {
  const pi = piEngineOn([() => fauxAssistantMessage("hello")]);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  session.send("hi");
  session.send("/name  Fixing the build ");
  const events = await turnEvents(session, 2);
  await session.close();

  const turn = lastTurn(events);
  assert.deepEqual(
    turn.map((e) => e.type),
    ["turn_started", "status", "turn_ended"],
  );
  assert.equal(pi.faux.state.callCount, 1);
  const id = (events.find((e) => e.type === "conversation") as { id: string }).id;
  const file = SessionManager.findById(pi.projectDir, id)!;
  assert.equal(SessionManager.open(file).getSessionName(), "Fixing the build");
});

test("PiEngine: /name with no text is refused and names nothing", async () => {
  const pi = piEngineOn([]);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  session.send("/name");
  const events = await turnEvents(session, 1);
  await session.close();
  const ended = events.find((e) => e.type === "turn_ended") as Extract<EngineEvent, { type: "turn_ended" }>;
  assert.equal(ended.outcome, "error");
  assert.equal(pi.faux.state.callCount, 0);
});

test("PiEngine: /reload picks up a new Skill, prompt template and .claude/skills directory, and re-emits menu", async () => {
  const pi = piEngineOn([]);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  const skill = (dir: string, name: string) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
  };
  skill(join(pi.projectDir, ".pi", "skills"), "fresh-pi");
  skill(join(pi.projectDir, ".claude", "skills"), "fresh-claude");
  mkdirSync(join(pi.projectDir, ".pi", "prompts"), { recursive: true });
  writeFileSync(join(pi.projectDir, ".pi", "prompts", "fresh-tpl.md"), "---\ndescription: t\n---\nbody\n");
  session.send("/reload");
  const events = await turnEvents(session, 1);
  await session.close();

  const menus = events.filter((e) => e.type === "menu") as Extract<EngineEvent, { type: "menu" }>[];
  assert.equal(menus.length, 2);
  const names = menus[1].skills.map((s) => s.name);
  for (const n of ["skill:fresh-pi", "skill:fresh-claude", "fresh-tpl"]) assert.ok(names.includes(n), n);
  assert.deepEqual(
    lastTurn(events).map((e) => e.type),
    ["turn_started", "menu", "status", "turn_ended"],
  );
});

test("PiEngine: the menu lists /session, /name and /reload as Local commands", async () => {
  const pi = piEngineOn([]);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  let menu: Extract<EngineEvent, { type: "menu" }> | undefined;
  for await (const e of session.events) if (e.type === "menu") { menu = e; break; }
  await session.close();
  const names = menu!.localCommands.map((c) => c.name);
  for (const n of ["session", "name", "reload"]) assert.ok(names.includes(n), n);
});

test("PiEngine: /session, /reload and /name run locally even with trailing text", async () => {
  const pi = piEngineOn([() => fauxAssistantMessage("hello")]);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  session.send("/session please");
  session.send("/reload now ");
  session.send("/name  Two words ");
  const events = await turnEvents(session, 3);
  await session.close();

  assert.equal(pi.faux.state.callCount, 0);
  const ended = events.filter((e) => e.type === "turn_ended") as Extract<EngineEvent, { type: "turn_ended" }>[];
  assert.deepEqual(
    ended.map((e) => e.outcome),
    ["success", "success", "success"],
  );
});
