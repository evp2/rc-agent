// Needs a live Pi credential and spends model calls, so it stays out of `npm test`.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type Credential, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { PiEngine } from "../../src/engine/pi/adapter";
import type { EngineAnswer, EngineEvent, EngineQuestion, EngineSession } from "../../src/engine/types";
import type { PiProviderConfig } from "../../src/provider";

const developersAuthFile = join(getAgentDir(), "auth.json");
const agentDir = mkdtempSync(join(tmpdir(), "crc-pi-contract-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
// Pi's default keepRecentTokens would make every Conversation here too small to compact.
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 300 } }));

const CANDIDATES: { piProvider: string; provider: PiProviderConfig }[] = [
  { piProvider: "anthropic", provider: { type: "anthropic", model: "claude-haiku-4-5" } },
  { piProvider: "github-copilot", provider: { type: "copilot", model: "claude-sonnet-4.6" } },
  {
    piProvider: "amazon-bedrock",
    provider: { type: "bedrock", model: "anthropic.claude-haiku-4-5-20251001-v1:0" },
  },
];

const SKIP =
  "no Pi credential -- set ANTHROPIC_API_KEY, or sign in with `pi` (/login anthropic or github-copilot), " +
  "or configure AWS credentials for Bedrock, to exercise the Pi contract";

function developersLogins(): Record<string, Credential> {
  if (!existsSync(developersAuthFile)) return {};
  try {
    return JSON.parse(readFileSync(developersAuthFile, "utf8"));
  } catch {
    return {};
  }
}

async function createModelRuntime(): Promise<ModelRuntime> {
  const credentials = new InMemoryCredentialStore();
  for (const [id, credential] of Object.entries(developersLogins())) {
    await credentials.modify(id, async () => credential);
  }
  return ModelRuntime.create({ credentials });
}

let chosen: Promise<PiProviderConfig | undefined> | undefined;

function usableProvider(): Promise<PiProviderConfig | undefined> {
  chosen ??= (async () => {
    try {
      const runtime = await createModelRuntime();
      for (const { piProvider, provider } of CANDIDATES) {
        if ((await runtime.checkAuth(piProvider)) !== undefined) return provider;
      }
    } catch {
      return undefined;
    }
    return undefined;
  })();
  return chosen;
}

interface Opened {
  session: EngineSession;
  it: AsyncIterator<EngineEvent>;
  questions: EngineQuestion[];
}

const homeDir = mkdtempSync(join(tmpdir(), "crc-pi-contract-home-"));

function workDir(): string {
  return mkdtempSync(join(tmpdir(), "crc-pi-contract-project-"));
}

async function openIn(
  provider: PiProviderConfig,
  projectDir: string,
  options: { resume?: string; answer?: (q: EngineQuestion) => EngineAnswer } = {},
): Promise<Opened> {
  const questions: EngineQuestion[] = [];
  const engine = new PiEngine({ provider, projectDir, homeDir, createModelRuntime });
  const session = await engine.open({
    projectDir,
    resume: options.resume,
    onQuestion: async (q) => {
      questions.push(q);
      if (!options.answer) return new Promise<EngineAnswer>(() => undefined);
      return options.answer(q);
    },
  });
  return { session, it: session.events[Symbol.asyncIterator](), questions };
}

const TIMED_OUT = Symbol("timed out");

async function collect(
  iterator: AsyncIterator<EngineEvent>,
  predicate: (e: EngineEvent) => boolean,
  timeoutMs = 120_000,
): Promise<EngineEvent[]> {
  const collected: EngineEvent[] = [];
  for (;;) {
    const raced = await Promise.race([
      iterator.next(),
      new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), timeoutMs)),
    ]);
    if (raced === TIMED_OUT) throw new Error(`timed out; collected so far: ${JSON.stringify(collected)}`);
    if (raced.done) throw new Error(`event stream ended; collected: ${JSON.stringify(collected)}`);
    collected.push(raced.value);
    if (predicate(raced.value)) return collected;
  }
}

type Ended = Extract<EngineEvent, { type: "turn_ended" }>;
type ConversationEvent = Extract<EngineEvent, { type: "conversation" }>;

async function collectTurns(iterator: AsyncIterator<EngineEvent>, count: number, timeoutMs = 180_000): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for (let seen = 0; seen < count; seen++) events.push(...(await collect(iterator, isEnded, timeoutMs)));
  return events;
}

const isEnded = (e: EngineEvent): boolean => e.type === "turn_ended";
const endedIn = (events: EngineEvent[]): Ended => events.find(isEnded) as Ended;
const conversationIn = (events: EngineEvent[]): ConversationEvent =>
  events.find((e) => e.type === "conversation") as ConversationEvent;
const textIn = (events: EngineEvent[]): string =>
  events.flatMap((e) => (e.type === "assistant_text" ? [e.text] : [])).join("\n");

const OK = "Reply with the single word OK and nothing else.";

test("PiEngine: a plain Turn reports a Conversation, an announcement, the menu, text, and a successful outcome with Usage", async (t) => {
  const provider = await usableProvider();
  if (!provider) return t.skip(SKIP);
  const { session, it } = await openIn(provider, workDir());
  try {
    session.send(OK);
    const events = await collect(it, isEnded);

    assert.equal(conversationIn(events).resumed, false);
    assert.ok(events.some((e) => e.type === "announce"), "no announce Event");
    assert.ok(events.some((e) => e.type === "menu"), "no menu Event");
    assert.deepEqual(
      events.filter((e) => e.type === "turn_started"),
      [{ type: "turn_started", cause: "command" }],
    );
    assert.match(textIn(events), /OK/i);
    const ended = endedIn(events);
    assert.equal(ended.outcome, "success");
    assert.ok(ended.usage, "a successful Turn against real Pi must carry Usage");
    assert.ok(ended.usage.inputTokens + ended.usage.cacheReadTokens > 0, "no input tokens counted");
    assert.ok(ended.usage.outputTokens > 0, "no output tokens counted");
    assert.ok(typeof ended.contextPercentage === "number", "a successful Turn reports a context percentage");
  } finally {
    await session.close();
  }
});

test("PiEngine: a Command sent while a Turn runs waits and runs as a Turn of its own, each with its own Usage", async (t) => {
  const provider = await usableProvider();
  if (!provider) return t.skip(SKIP);
  const { session, it } = await openIn(provider, workDir());
  try {
    session.send("Reply with the single word ALPHA and nothing else.");
    session.send("Reply with the single word BRAVO and nothing else.");
    const events = await collectTurns(it, 2);

    const shape = events.filter((e) => e.type === "turn_started" || e.type === "turn_ended").map((e) => e.type);
    assert.deepEqual(shape, ["turn_started", "turn_ended", "turn_started", "turn_ended"]);
    const [first, second] = events.filter(isEnded) as Ended[];
    assert.equal(first.outcome, "success");
    assert.equal(second.outcome, "success");
    assert.ok(first.usage && second.usage, "each Turn carries Usage");
    assert.ok(
      second.usage.inputTokens + second.usage.cacheReadTokens > first.usage.inputTokens + first.usage.cacheReadTokens,
      "the second Turn's Usage is its own call over a longer history, not a running total",
    );
    const firstEnd = events.findIndex(isEnded);
    assert.match(textIn(events.slice(0, firstEnd)), /ALPHA/i);
    assert.match(textIn(events.slice(firstEnd)), /BRAVO/i);
  } finally {
    await session.close();
  }
});

test("PiEngine: Stop ends the Turn promptly, and the session carries on", async (t) => {
  const provider = await usableProvider();
  if (!provider) return t.skip(SKIP);
  const { session, it } = await openIn(provider, workDir());
  try {
    session.send("Count slowly from 1 to 2000, one number per line, with no other text.");
    await collect(it, (e) => e.type === "turn_started");
    const stoppedAt = Date.now();
    session.stop();
    const events = await collect(it, isEnded, 30_000);
    assert.equal(endedIn(events).outcome, "stopped");
    assert.ok(Date.now() - stoppedAt < 15_000, "Stop ended the Turn promptly");

    session.send(OK);
    const next = await collect(it, isEnded);
    assert.equal(endedIn(next).outcome, "success", "an aborted call must not poison the next Turn");
    assert.match(textIn(next), /OK/i);
  } finally {
    await session.close();
  }
});

test("PiEngine: a Question reaches onQuestion as a Question, and its answer resolves the Turn", async (t) => {
  const provider = await usableProvider();
  if (!provider) return t.skip(SKIP);
  const { session, it, questions } = await openIn(provider, workDir(), {
    answer: (q) => ({ answers: { [q.questions[0].question]: "blue" } }),
  });
  try {
    session.send(
      "Use the ask_user_question tool to ask me one question, which colour I prefer, with the options red and blue. " +
        "Do not answer it yourself. Once I have answered, reply with just the colour I chose.",
    );
    const events = await collect(it, isEnded);

    assert.equal(questions.length, 1, "the Question reached onQuestion once");
    assert.equal(questions[0].questions.length, 1);
    assert.deepEqual(
      questions[0].questions[0].options.map((o) => o.label.toLowerCase()).sort(),
      ["blue", "red"],
    );
    assert.ok(
      !events.some((e) => (e.type === "tool_use" || e.type === "tool_result") && "name" in e && e.name === "ask_user_question"),
      "the Question tool is not reported as an ordinary tool call",
    );
    assert.equal(endedIn(events).outcome, "success");
    assert.match(textIn(events), /blue/i);
  } finally {
    await session.close();
  }
});

test("PiEngine: Stop with a Question pending ends the Turn and the session carries on", async (t) => {
  const provider = await usableProvider();
  if (!provider) return t.skip(SKIP);
  const { session, it, questions } = await openIn(provider, workDir());
  try {
    session.send(
      "Use the ask_user_question tool to ask me one question, which colour I prefer, with the options red and blue. " +
        "Do not answer it yourself.",
    );
    const deadline = Date.now() + 120_000;
    while (questions.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(questions.length, 1, "the model asked the Question");
    session.stop();
    const events = await collect(it, isEnded, 30_000);
    assert.equal(endedIn(events).outcome, "stopped");

    session.send(OK);
    assert.equal(endedIn(await collect(it, isEnded)).outcome, "success");
  } finally {
    await session.close();
  }
});

test("PiEngine: a Conversation resumes across a close and remembers earlier Turns", async (t) => {
  const provider = await usableProvider();
  if (!provider) return t.skip(SKIP);
  const dir = workDir();
  const first = await openIn(provider, dir);
  let id: string;
  try {
    first.session.send("Remember the codeword PERIWINKLE. Reply with just OK.");
    const events = await collect(first.it, isEnded);
    assert.equal(endedIn(events).outcome, "success");
    id = conversationIn(events).id;
  } finally {
    await first.session.close();
  }

  const second = await openIn(provider, dir, { resume: id });
  try {
    second.session.send("What was the codeword? Reply with just that word.");
    const events = await collect(second.it, isEnded);
    const conversation = conversationIn(events);
    assert.equal(conversation.id, id);
    assert.equal(conversation.resumed, true);
    assert.equal(conversation.lostPrevious, undefined);
    assert.match(textIn(events), /periwinkle/i);
  } finally {
    await second.session.close();
  }
});

test("PiEngine: a Conversation Pi doesn't have opens fresh and is reported as lost", async (t) => {
  const provider = await usableProvider();
  if (!provider) return t.skip(SKIP);
  const { session, it } = await openIn(provider, workDir(), { resume: "00000000-0000-0000-0000-000000000000" });
  try {
    session.send(OK);
    const events = await collect(it, isEnded);
    const conversation = conversationIn(events);
    assert.equal(conversation.resumed, false);
    assert.equal(conversation.lostPrevious, true);
    assert.notEqual(conversation.id, "00000000-0000-0000-0000-000000000000");
    assert.equal(endedIn(events).outcome, "success");
  } finally {
    await session.close();
  }
});

test("PiEngine: /compact summarises the Conversation, reports it, and the Conversation carries on", async (t) => {
  const provider = await usableProvider();
  if (!provider) return t.skip(SKIP);
  const { session, it } = await openIn(provider, workDir());
  try {
    session.send("Remember the codeword PERIWINKLE, then write a 150-word paragraph about tide pools.");
    assert.equal(endedIn(await collect(it, isEnded)).outcome, "success");
    session.send("Now write a 150-word paragraph about deserts.");
    assert.equal(endedIn(await collect(it, isEnded)).outcome, "success");

    session.send("/compact");
    const events = await collect(it, isEnded, 180_000);
    assert.deepEqual(
      events.filter((e) => e.type === "turn_started"),
      [{ type: "turn_started", cause: "command" }],
    );
    assert.ok(events.some((e) => e.type === "compacting" && e.trigger === "manual"), "no compacting Event");
    const compacted = events.find((e) => e.type === "compacted") as Extract<EngineEvent, { type: "compacted" }>;
    assert.ok(compacted, "no compacted Event");
    assert.ok((compacted.preTokens ?? 0) > 0);
    const ended = endedIn(events);
    assert.equal(ended.outcome, "success");
    assert.ok(ended.usage && ended.usage.outputTokens > 0, "the summary call's Usage belongs to the /compact Turn");

    session.send("What was the codeword? Reply with just that word.");
    const after = await collect(it, isEnded);
    assert.equal(endedIn(after).outcome, "success");
    assert.match(textIn(after), /periwinkle/i, "the summary kept what mattered");
  } finally {
    await session.close();
  }
});
