import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import type { EngineAnswer, EngineEvent, EngineSession } from "../src/engine/types.ts";
import { maybeSubmitAutoCompact } from "../src/session/loop.ts";
import { runTurn } from "../src/session/turn.ts";
import { cmd, makeTurnHarness, until } from "./doubles.ts";
import { answeringByPrompt, freshProjectDir, piEngineOn, writePiSettings } from "./piDoubles.ts";

// Pi keeps the last 20,000 tokens out of a compaction by default, more than any of these Conversations holds.
before(() => writePiSettings({ compaction: { enabled: false, keepRecentTokens: 300 } }));
after(() => writePiSettings({}));

type Menu = Extract<EngineEvent, { type: "menu" }>;

function openOptions(projectDir: string) {
  return {
    projectDir,
    onQuestion: () => new Promise<EngineAnswer>(() => undefined),
  };
}

function writeSkill(skillsDir: string, name: string, description: string, body = `Do the ${name} thing.`): void {
  mkdirSync(join(skillsDir, name), { recursive: true });
  writeFileSync(join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
}

function writePromptTemplate(
  projectDir: string,
  name: string,
  description: string,
  body: string,
  argumentHint?: string,
): void {
  const dir = join(projectDir, ".pi", "prompts");
  mkdirSync(dir, { recursive: true });
  const hint = argumentHint ? `argument-hint: "${argumentHint}"\n` : "";
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${description}\n${hint}---\n${body}\n`);
}

async function firstMenu(session: EngineSession): Promise<Menu> {
  for await (const event of session.events) if (event.type === "menu") return event;
  throw new Error("no menu");
}

test("PiEngine: the menu lists Pi's Skills and prompt templates, the project's and user's .claude/skills, /compact and /clear", async () => {
  const homeDir = freshProjectDir();
  const pi = piEngineOn([], { homeDir });
  writeSkill(join(pi.projectDir, ".pi", "skills"), "pi-own", "Pi's own skill");
  writeSkill(join(pi.projectDir, ".claude", "skills"), "project-claude", "A project Claude skill");
  writeSkill(join(homeDir, ".claude", "skills"), "user-claude", "A user Claude skill");
  writeSkill(join(pi.projectDir, ".pi", "skills"), "shared", "Pi's copy");
  writeSkill(join(pi.projectDir, ".claude", "skills"), "shared", "The project Claude copy");
  writeSkill(join(homeDir, ".claude", "skills"), "shared", "The user Claude copy");
  writePromptTemplate(pi.projectDir, "review", "Review a file", "Review $1 carefully.", "<file>");

  const session = await pi.engine.open(openOptions(pi.projectDir));
  const menu = await firstMenu(session);
  await session.close();

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  assert.deepEqual([...menu.skills].sort(byName), [
    { name: "review", description: "Review a file", argumentHint: "<file>" },
    { name: "skill:pi-own", description: "Pi's own skill", argumentHint: "" },
    {
      name: "skill:project-claude",
      description: "A project Claude skill",
      argumentHint: "",
    },
    { name: "skill:shared", description: "Pi's copy", argumentHint: "" },
    {
      name: "skill:user-claude",
      description: "A user Claude skill",
      argumentHint: "",
    },
  ]);
  assert.deepEqual(
    menu.localCommands.map((c) => c.name),
    ["compact", "clear"],
  );
});

test("PiEngine: a Skill from .claude/skills and a prompt template invoked from the phone run on Pi, expanded", async () => {
  const homeDir = freshProjectDir();
  const model = answeringByPrompt(() => fauxAssistantMessage("done"));
  const pi = piEngineOn(model.steps, { homeDir });
  writeSkill(join(homeDir, ".claude", "skills"), "greet", "Greets", "Say the secret word PINEAPPLE.");
  writePromptTemplate(pi.projectDir, "review", "Review a file", "Review $1 carefully.");

  const session = await pi.engine.open(openOptions(pi.projectDir));
  session.send("/skill:greet to Bob");
  session.send("/review src/main.ts");
  let ended = 0;
  for await (const event of session.events) if (event.type === "turn_ended" && ++ended === 2) break;
  await session.close();

  assert.equal(model.prompts.length, 2);
  assert.match(model.prompts[0], /<skill name="greet"[\s\S]*PINEAPPLE[\s\S]*<\/skill>\s+to Bob$/);
  assert.equal(model.prompts[1], "Review src/main.ts carefully.");
});

async function readTurns(session: EngineSession, count: number): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  let ended = 0;
  for await (const event of session.events) {
    events.push(event);
    if (event.type === "turn_ended" && ++ended === count) return events;
  }
  throw new Error(`event stream ended after ${JSON.stringify(events)}`);
}

function lastTurn(events: EngineEvent[]): EngineEvent[] {
  return events.slice(events.findLastIndex((e) => e.type === "turn_started"));
}

const summarising = () =>
  answeringByPrompt((prompt) =>
    prompt.includes("checkpoint") ? fauxAssistantMessage("## Goal\nchatted") : fauxAssistantMessage("ok ".repeat(200)),
  );

test("PiEngine: /compact runs Pi's own compaction as a Turn of its own, with its Usage", async () => {
  const model = summarising();
  const pi = piEngineOn(model.steps);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  session.send("hello");
  session.send("and again");
  session.send("/compact keep the greetings");
  const events = await readTurns(session, 3);
  await session.close();

  const turn = lastTurn(events);
  assert.deepEqual(
    turn.map((e) => e.type),
    ["turn_started", "compacting", "compacted", "turn_ended"],
  );
  assert.deepEqual(turn[0], { type: "turn_started", cause: "command" });
  assert.deepEqual(turn[1], { type: "compacting", trigger: "manual" });
  const compacted = turn[2] as Extract<EngineEvent, { type: "compacted" }>;
  assert.ok(compacted.preTokens! > compacted.postTokens!, JSON.stringify(compacted));
  const ended = turn[3] as Extract<EngineEvent, { type: "turn_ended" }>;
  assert.equal(ended.outcome, "success");
  assert.ok(ended.usage && ended.usage.inputTokens > 0, "the summary call's Usage is the Turn's");
  assert.equal(ended.contextPercentage, undefined, "Pi has no reading right after a compaction");
  assert.match(model.prompts.at(-1)!, /keep the greetings/);
});

test("PiEngine: /compact on a Conversation too small to compact ends in an error, said once", async () => {
  const pi = piEngineOn([]);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  session.send("/compact");
  const events = await readTurns(session, 1);
  await session.close();

  const turn = lastTurn(events);
  assert.deepEqual(
    turn.map((e) => e.type),
    ["turn_started", "compacting", "status", "turn_ended"],
  );
  assert.match((turn[2] as Extract<EngineEvent, { type: "status" }>).text, /Nothing to compact/);
  const ended = turn[3] as Extract<EngineEvent, { type: "turn_ended" }>;
  assert.equal(ended.outcome, "error");
  assert.equal(ended.errors, undefined, "the status already said why");
});

test("PiEngine: a Stop during /compact ends its Turn stopped, and the next Command still runs", async () => {
  let release!: () => void;
  const model = answeringByPrompt((prompt) =>
    prompt.includes("checkpoint")
      ? (_context, options) =>
          new Promise((resolve) => {
            release();
            options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("cut short")), {
              once: true,
            });
          })
      : fauxAssistantMessage("ok ".repeat(200)),
  );
  const summaryAsked = new Promise<void>((resolve) => (release = resolve));
  const pi = piEngineOn(model.steps);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  session.send("hello");
  session.send("and again");
  session.send("/compact");
  void summaryAsked.then(() => session.stop());
  const events = await readTurns(session, 3);
  session.send("still there?");
  events.push(...(await readTurns(session, 1)));
  await session.close();

  const ends = events.filter((e) => e.type === "turn_ended") as Extract<EngineEvent, { type: "turn_ended" }>[];
  assert.deepEqual(
    ends.map((e) => e.outcome),
    ["success", "success", "stopped", "success"],
  );
  assert.equal(
    events.some((e) => e.type === "compacted" || e.type === "status"),
    false,
  );
});

test("PiEngine: a Stop sent the moment /compact starts still ends its Turn stopped", async () => {
  const model = answeringByPrompt((prompt) =>
    prompt.includes("checkpoint")
      ? (_context, options) =>
          new Promise((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("cut short")), {
              once: true,
            }),
          )
      : fauxAssistantMessage("ok ".repeat(200)),
  );
  const pi = piEngineOn(model.steps);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  session.send("hello");
  session.send("and again");
  const events = await readTurns(session, 2);
  session.send("/compact");
  session.stop();
  events.push(...(await readTurns(session, 1)));
  await session.close();

  const ends = events.filter((e) => e.type === "turn_ended") as Extract<EngineEvent, { type: "turn_ended" }>[];
  assert.deepEqual(
    ends.map((e) => e.outcome),
    ["success", "success", "stopped"],
  );
});

test("PiEngine: Auto-compact, once due, compacts the Pi Conversation through the same Command path as the phone", async () => {
  const pi = piEngineOn(summarising().steps);
  const h = await makeTurnHarness({
    engine: pi.engine,
    projectDir: pi.projectDir,
    config: { inactivityCompact: { afterMinutes: 30 } },
  });
  await until(() => h.relay.putSkillsCalls.length > 0);
  assert.deepEqual(
    (h.relay.putSkillsCalls[0].localCommands as { name: string }[]).map((c) => c.name),
    ["compact", "clear"],
  );
  await runTurn(h.ctx, cmd("hello"));
  await runTurn(h.ctx, cmd("and again"));
  h.ctx.state.lastRealTurnCompletedAt = new Date(Date.now() - 31 * 60_000).toISOString();

  await maybeSubmitAutoCompact(h.ctx);
  assert.deepEqual(h.relay.postedCommands, ["/compact"]);
  await runTurn(h.ctx, cmd(h.relay.postedCommands[0], undefined, "auto"));
  await h.close();

  const complete = h.ctx.eventBuffer.filter((e) => e.type === "turn_complete").at(-1)!;
  assert.equal(complete.is_error, undefined, JSON.stringify(h.ctx.eventBuffer));
  assert.equal(complete.no_notify, true);
  const statuses = h.ctx.eventBuffer.filter((e) => e.type === "status").map((e) => e.text);
  assert.ok(
    statuses.some((text) => /^compacted \(\d+ → \d+ tokens\)$/.test(text ?? "")),
    JSON.stringify(statuses),
  );
});
