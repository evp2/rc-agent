import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { test } from "node:test";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import type { ArchiveFileOutcome, EngineAnswer, EngineEvent, EngineFile, EngineSession } from "../src/engine/types.ts";
import { piEngineOn } from "./piDoubles.ts";

async function runCommands(
  session: EngineSession,
  commands: string[],
): Promise<EngineEvent[]> {
  for (const command of commands) session.send(command);
  const events: EngineEvent[] = [];
  let ended = 0;
  for await (const event of session.events) {
    events.push(event);
    if (event.type === "turn_ended" && ++ended === commands.length) break;
  }
  await session.close();
  return events;
}

function lastTurn(events: EngineEvent[]): EngineEvent[] {
  return events.slice(events.findLastIndex((e) => e.type === "turn_started"));
}

test("PiEngine: /export hands Pi's HTML export over as an Archived file", async () => {
  const pi = piEngineOn([fauxAssistantMessage("the codeword is ZEBRA")]);
  const archived: { file: EngineFile; html: string }[] = [];
  const session = await pi.engine.open({
    projectDir: pi.projectDir,
    onQuestion: () => new Promise<EngineAnswer>(() => undefined),
    onArchiveFile: async (file): Promise<ArchiveFileOutcome> => {
      archived.push({ file, html: readFileSync(file.path, "utf8") });
      return { archived: true, filename: basename(file.path), byteLength: 1 };
    },
  });
  const events = await runCommands(session, ["hello", "/export"]);

  assert.equal(archived.length, 1);
  assert.match(archived[0].file.path, /\.html$/);
  assert.match(archived[0].html, /<html/i);
  assert.equal(existsSync(archived[0].file.path), false, "the temporary file is removed afterwards");
  assert.deepEqual(
    lastTurn(events).map((e) => e.type),
    ["turn_started", "turn_ended"],
  );
  assert.equal((lastTurn(events)[1] as Extract<EngineEvent, { type: "turn_ended" }>).outcome, "success");
});

test("PiEngine: a refused /export is a status and an errored Turn", async () => {
  const pi = piEngineOn([fauxAssistantMessage("ok")]);
  const session = await pi.engine.open({
    projectDir: pi.projectDir,
    onQuestion: () => new Promise<EngineAnswer>(() => undefined),
    onArchiveFile: async () => ({ archived: false, reason: "the upload was refused" }),
  });
  const turn = lastTurn(await runCommands(session, ["hello", "/export"]));

  assert.deepEqual(turn[1], { type: "status", text: "the upload was refused" });
  const ended = turn[2] as Extract<EngineEvent, { type: "turn_ended" }>;
  assert.equal(ended.outcome, "error");
  assert.deepEqual(ended.errors, ["the upload was refused"]);
});

test("PiEngine: /export with no Archived file route is an errored Turn", async () => {
  const pi = piEngineOn([fauxAssistantMessage("ok")]);
  const session = await pi.engine.open({
    projectDir: pi.projectDir,
    onQuestion: () => new Promise<EngineAnswer>(() => undefined),
  });
  const turn = lastTurn(await runCommands(session, ["hello", "/export"]));
  assert.equal((turn.at(-1) as Extract<EngineEvent, { type: "turn_ended" }>).outcome, "error");
});

test("PiEngine: /export with trailing text still runs locally", async () => {
  const pi = piEngineOn([fauxAssistantMessage("ok")]);
  const session = await pi.engine.open({
    projectDir: pi.projectDir,
    onQuestion: () => new Promise<EngineAnswer>(() => undefined),
    onArchiveFile: async () => ({ archived: true, filename: "x.html", byteLength: 1 }),
  });
  const events = await runCommands(session, ["hello", "/export now"]);
  assert.equal(pi.faux.state.callCount, 1);
  assert.equal((events.at(-1) as Extract<EngineEvent, { type: "turn_ended" }>).outcome, "success");
});

test("PiEngine: Stop during /export aborts the upload and ends the Turn stopped", async () => {
  const pi = piEngineOn([fauxAssistantMessage("ok")]);
  let reached!: () => void;
  const uploading = new Promise<void>((resolve) => (reached = resolve));
  const session = await pi.engine.open({
    projectDir: pi.projectDir,
    onQuestion: () => new Promise<EngineAnswer>(() => undefined),
    onArchiveFile: (_file, signal) =>
      new Promise<ArchiveFileOutcome>((resolve) => {
        reached();
        signal.addEventListener("abort", () => resolve({ archived: false, reason: "stopped" }), { once: true });
      }),
  });
  session.send("hello");
  session.send("/export");
  await uploading;
  session.stop();
  let outcome: string | undefined;
  let ended = 0;
  for await (const event of session.events) {
    if (event.type === "turn_ended" && ++ended === 2) {
      outcome = event.outcome;
      break;
    }
  }
  await session.close();
  assert.equal(outcome, "stopped");
});

test("PiEngine: the menu lists /export as a Local command", async () => {
  const pi = piEngineOn([]);
  const session = await pi.engine.open({
    projectDir: pi.projectDir,
    onQuestion: () => new Promise<EngineAnswer>(() => undefined),
  });
  let menu: Extract<EngineEvent, { type: "menu" }> | undefined;
  for await (const event of session.events) {
    if (event.type === "menu") {
      menu = event;
      break;
    }
  }
  await session.close();
  assert.ok(menu?.localCommands.some((c) => c.name === "export"));
});
