import assert from "node:assert/strict";
import { after, test } from "node:test";

import { fauxAssistantMessage, fauxText, fauxToolCall, type Usage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { EngineAnswer, EngineEvent, EngineSession, EngineUsage } from "../src/engine/types.ts";
import { answeringByPrompt, piEngineOn, writePiSettings } from "./piDoubles.ts";

after(() => writePiSettings({}));

type TurnEnded = Extract<EngineEvent, { type: "turn_ended" }>;

const PRICES = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

function openOptions(projectDir: string) {
  return { projectDir, onQuestion: () => new Promise<EngineAnswer>(() => undefined) };
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

function lastTurnEnded(events: EngineEvent[]): TurnEnded {
  return events.filter((e): e is TurnEnded => e.type === "turn_ended").at(-1)!;
}

function recordedUsages(projectDir: string, conversationId: string): Usage[] {
  const file = SessionManager.findById(projectDir, conversationId);
  assert.ok(file, "Pi kept the session");
  return SessionManager.open(file)
    .getEntries()
    .flatMap((entry) => {
      if (entry.type === "message" && entry.message.role === "assistant") return [entry.message.usage];
      if (entry.type === "compaction" && entry.usage) return [entry.usage];
      return [];
    });
}

function summed(usages: Usage[]): EngineUsage {
  return {
    inputTokens: usages.reduce((n, u) => n + u.input, 0),
    outputTokens: usages.reduce((n, u) => n + u.output, 0),
    cacheReadTokens: usages.reduce((n, u) => n + u.cacheRead, 0),
    cacheWriteTokens: usages.reduce((n, u) => n + u.cacheWrite, 0),
    costUsd: usages.reduce((n, u) => n + u.cost.total, 0),
  };
}

function conversationId(events: EngineEvent[]): string {
  const conversation = events.find((e) => e.type === "conversation") as Extract<EngineEvent, { type: "conversation" }>;
  return conversation.id;
}

const COMPACTING_WINDOW = 20_000;
function compactAbove3000Tokens(): void {
  writePiSettings({ compaction: { enabled: true, reserveTokens: COMPACTING_WINDOW - 3_000, keepRecentTokens: 300 } });
}

function filledByABigReply() {
  return answeringByPrompt((prompt) =>
    prompt.includes("checkpoint")
      ? fauxAssistantMessage("## Goal\nsaid hello")
      : prompt.startsWith("big")
        ? fauxAssistantMessage("word ".repeat(3_000))
        : fauxAssistantMessage("ok"),
  );
}

function compactions(projectDir: string, conversationId: string) {
  const file = SessionManager.findById(projectDir, conversationId)!;
  return SessionManager.open(file)
    .getEntries()
    .filter((entry) => entry.type === "compaction");
}

const twoCalls = () => [
  fauxAssistantMessage([fauxText("looking"), fauxToolCall("bash", { command: "echo hi" })], { stopReason: "toolUse" }),
  fauxAssistantMessage("done"),
];

test("PiEngine: a Turn's Usage is the sum of its model calls, in tokens and dollars on a per-call login", async () => {
  const pi = piEngineOn(twoCalls(), { model: { cost: PRICES } });
  const session = await pi.engine.open(openOptions(pi.projectDir));
  session.send("look around");
  const events = await readTurns(session, 1);
  await session.close();

  const recorded = recordedUsages(pi.projectDir, conversationId(events));
  assert.equal(recorded.length, 2);
  const usage = lastTurnEnded(events).usage;
  assert.ok(usage && usage.costUsd! > 0, `a priced Turn: ${JSON.stringify(usage)}`);
  assert.deepEqual(usage, summed(recorded));
});

test("PiEngine: on a subscription login a Turn records its tokens but no dollar figure", async () => {
  const pi = piEngineOn(twoCalls(), { model: { cost: PRICES }, subscription: true });
  const session = await pi.engine.open(openOptions(pi.projectDir));
  session.send("look around");
  const events = await readTurns(session, 1);
  await session.close();

  const recorded = recordedUsages(pi.projectDir, conversationId(events));
  assert.ok(summed(recorded).costUsd! > 0, "Pi itself still priced the calls at list price");
  const { costUsd: _, ...tokens } = summed(recorded);
  assert.deepEqual(lastTurnEnded(events).usage, tokens);
});

test("PiEngine: each call is billed or not by the login it ran on, not the login at the Turn's end", async () => {
  const pi = piEngineOn([], { model: { cost: PRICES }, subscription: true });
  pi.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })], { stopReason: "toolUse" }),
    async () => {
      await pi.runtime().setRuntimeApiKey("anthropic", "metered-key");
      return fauxAssistantMessage("done");
    },
  ]);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  session.send("look around");
  const events = await readTurns(session, 1);
  await session.close();

  const [first, second] = recordedUsages(pi.projectDir, conversationId(events));
  assert.ok(first.cost.total > 0 && second.cost.total > 0);
  assert.equal(lastTurnEnded(events).usage?.costUsd, second.cost.total);
});

test("PiEngine: a Turn ends with how full Pi's context is, against Pi's own limit for the model", async () => {
  const contextWindow = 20_000;
  const pi = piEngineOn([fauxAssistantMessage("hi")], { model: { contextWindow } });
  const session = await pi.engine.open(openOptions(pi.projectDir));
  session.send("hello");
  const events = await readTurns(session, 1);
  await session.close();

  const [call] = recordedUsages(pi.projectDir, conversationId(events));
  const expected = Math.round((call.totalTokens / contextWindow) * 100);
  assert.ok(expected > 0, `a context that registers: ${call.totalTokens} tokens`);
  assert.equal(lastTurnEnded(events).contextPercentage, expected);
});

test("PiEngine: a compaction after Pi's run is reported inside that Turn, and its Usage is the Turn's", async () => {
  compactAbove3000Tokens();
  try {
    const model = filledByABigReply();
    const pi = piEngineOn(model.steps, { model: { contextWindow: COMPACTING_WINDOW, cost: PRICES } });
    const session = await pi.engine.open(openOptions(pi.projectDir));
    session.send("hello");
    session.send("big reply please");
    const events = await readTurns(session, 2);
    await session.close();

    const id = conversationId(events);
    const [compaction] = compactions(pi.projectDir, id);
    assert.ok(compaction?.usage, "Pi compacted, with a model call of its own");
    const secondTurn = events.slice(events.findLastIndex((e) => e.type === "turn_started"));
    const compacted = secondTurn.find((e) => e.type === "compacted") as Extract<EngineEvent, { type: "compacted" }>;
    assert.deepEqual(
      secondTurn.map((e) => e.type),
      ["turn_started", "assistant_text", "compacting", "compacted", "turn_ended"],
    );
    assert.deepEqual(secondTurn[2], { type: "compacting", trigger: "auto" });
    assert.equal(compacted.preTokens, compaction.tokensBefore);
    assert.ok(compacted.postTokens! < compacted.preTokens!, JSON.stringify(compacted));
    assert.equal("contextPercentage" in compacted, false, "Pi has no reading until its next model call");

    const ended = lastTurnEnded(events);
    assert.equal(ended.contextPercentage, undefined);
    const [, ...secondTurnUsages] = recordedUsages(pi.projectDir, id);
    assert.deepEqual(ended.usage, summed(secondTurnUsages));
  } finally {
    writePiSettings({});
  }
});

test("PiEngine: a compaction Pi runs before its first model call is inside the Turn, which still ends with a reading", async () => {
  writePiSettings({ compaction: { enabled: false } });
  try {
    const model = filledByABigReply();
    const pi = piEngineOn(model.steps, { model: { contextWindow: COMPACTING_WINDOW } });
    const first = await pi.engine.open(openOptions(pi.projectDir));
    first.send("hello");
    first.send("big reply please");
    const id = conversationId(await readTurns(first, 2));
    await first.close();

    compactAbove3000Tokens();
    const session = await pi.engine.open({ ...openOptions(pi.projectDir), resume: id });
    session.send("and now?");
    const events = await readTurns(session, 1);
    await session.close();

    assert.deepEqual(
      events.filter((e) => e.type !== "conversation" && e.type !== "announce" && e.type !== "menu").map((e) => e.type),
      ["turn_started", "compacting", "compacted", "assistant_text", "turn_ended"],
    );
    assert.equal(typeof lastTurnEnded(events).contextPercentage, "number");
  } finally {
    writePiSettings({});
  }
});

test("PiEngine: a compaction Pi runs between two model calls of one run is inside that Turn", async () => {
  compactAbove3000Tokens();
  try {
    const model = answeringByPrompt((prompt) =>
      prompt.includes("checkpoint")
        ? fauxAssistantMessage("## Goal\nlisted numbers")
        : fauxAssistantMessage("ok"),
    );
    const steps = [
      fauxAssistantMessage("ok"),
      fauxAssistantMessage([fauxToolCall("bash", { command: "seq 1 4000" }, { id: "call-1" })], { stopReason: "toolUse" }),
      ...model.steps,
    ];
    const pi = piEngineOn(steps, { model: { contextWindow: COMPACTING_WINDOW } });
    const session = await pi.engine.open(openOptions(pi.projectDir));
    session.send("hello");
    session.send("list some numbers");
    const events = await readTurns(session, 2);
    await session.close();

    const secondTurn = events.slice(events.findLastIndex((e) => e.type === "turn_started"));
    const types = secondTurn.map((e) => e.type);
    assert.deepEqual(types.slice(0, 6), [
      "turn_started",
      "tool_use",
      "tool_result",
      "compacting",
      "compacted",
      "assistant_text",
    ]);
    assert.equal(types.at(-1), "turn_ended");
  } finally {
    writePiSettings({});
  }
});

test("PiEngine: a compaction that fails is said on the phone as a status, and the Turn still ends", async () => {
  compactAbove3000Tokens();
  try {
    const model = answeringByPrompt((prompt) =>
      prompt.includes("checkpoint")
        ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary model overloaded" })
        : prompt.startsWith("big")
          ? fauxAssistantMessage("word ".repeat(3_000))
          : fauxAssistantMessage("ok"),
    );
    const pi = piEngineOn(model.steps, { model: { contextWindow: COMPACTING_WINDOW } });
    const session = await pi.engine.open(openOptions(pi.projectDir));
    session.send("hello");
    session.send("big reply please");
    const events = await readTurns(session, 2);
    await session.close();

    const secondTurn = events.slice(events.findLastIndex((e) => e.type === "turn_started"));
    assert.deepEqual(
      secondTurn.map((e) => e.type),
      ["turn_started", "assistant_text", "compacting", "status", "turn_ended"],
    );
    const status = secondTurn[3] as Extract<EngineEvent, { type: "status" }>;
    assert.match(status.text, /compaction failed.*summary model overloaded/i);
  } finally {
    writePiSettings({});
  }
});
