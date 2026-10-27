import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { Engine, EngineAnswer, EngineEvent, EngineQuestion, EngineSession } from "../src/engine/types.ts";
import {
  ARCHIVE_FILE_CALL,
  runEngineGuaranteeSuite,
  SHOW_IMAGE_CALL,
  type EngineGuaranteeHarness,
} from "./engineGuaranteeSuite.ts";
import type { PiProviderConfig } from "../src/provider.ts";
import { answeringByPrompt, callingTools, FAUX_MODEL, FOREIGN_MODEL, piEngineOn, startingShell, untilAborted, writePiSettings } from "./piDoubles.ts";

after(() => writePiSettings({}));

const harness: EngineGuaranteeHarness = {
  makeSimpleEngine: () => piEngineOn([fauxAssistantMessage("hi")]).engine,
  makeErroringEngine: () =>
    piEngineOn([fauxAssistantMessage("", { stopReason: "error", errorMessage: "model call failed" })]).engine,
  makeHangingEngine: () => piEngineOn([untilAborted]).engine,
  makeQueueingEngine: () => piEngineOn([fauxAssistantMessage("first"), fauxAssistantMessage("second")]).engine,
  makeSteerableEngine: () => {
    let steered!: () => void;
    const steer = new Promise<void>((resolve) => (steered = resolve));
    const { engine } = piEngineOn([
      async () => {
        await steer;
        return fauxAssistantMessage(fauxToolCall("bash", { command: "true" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("corrected"),
    ]);
    return releasedBySteer(engine, steered);
  },
  killsBackgroundTasks: true,
  makeBackgroundTaskEngine: () => piEngineOn([startingShell("sleep 30"), untilAborted]).engine,
  makeWakingBackgroundTaskEngine: () =>
    piEngineOn([startingShell("sleep 0.3"), fauxAssistantMessage("started it"), fauxAssistantMessage("it finished")])
      .engine,
  makeShowImageEngine: () => {
    const { toolUseId: id, path, caption } = SHOW_IMAGE_CALL;
    const model = callingTools([{ name: "show_image", args: { path, caption: caption! }, id }]);
    return { engine: piEngineOn(model.steps).engine, toolResult: () => model.results().get(id) };
  },
  makeArchiveFileEngine: () => {
    const { toolUseId: id, path } = ARCHIVE_FILE_CALL;
    const model = callingTools([{ name: "archive_file", args: { path }, id }]);
    return { engine: piEngineOn(model.steps).engine, toolResult: () => model.results().get(id) };
  },
};

function releasedBySteer(engine: Engine, hook: () => void): Engine {
  return {
    kind: engine.kind,
    capabilities: engine.capabilities,
    verify: () => engine.verify(),
    open: async (options) => {
      const session = await engine.open(options);
      return {
        events: session.events,
        send: (text) => session.send(text),
        steer: (text) => {
          session.steer(text);
          hook();
        },
        stop: () => session.stop(),
        killTask: (id) => session.killTask(id),
        close: () => session.close(),
      };
    },
  };
}

runEngineGuaranteeSuite("PiEngine", harness);

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

function withoutDurations(events: EngineEvent[]): unknown[] {
  return events.map((e) => {
    if (e.type !== "turn_ended") return e;
    const { durationMs: _, usage: __, contextPercentage: ___, ...rest } = e;
    return rest;
  });
}

test("PiEngine: a Command's text, tool calls and tool results reach the phone, after an announce naming Pi's model", async () => {
  const pi = piEngineOn([
    fauxAssistantMessage([fauxText("let me look"), fauxToolCall("bash", { command: "echo hi" }, { id: "call-1" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  session.send("what's here?");
  const events = await readTurns(session, 1);
  assert.deepEqual(withoutDurations(events.filter((e) => e.type !== "conversation" && e.type !== "menu")), [
    { type: "announce", model: FAUX_MODEL, permissionMode: "bypassPermissions" },
    { type: "turn_started", cause: "command" },
    { type: "assistant_text", text: "let me look" },
    { type: "tool_use", toolUseId: "call-1", name: "bash", input: { command: "echo hi" } },
    { type: "tool_result", toolUseId: "call-1", text: "hi\n", isError: false },
    { type: "assistant_text", text: "done" },
    { type: "turn_ended", outcome: "success" },
  ]);
  await session.close();
});

test("PiEngine: Commands sent during a Turn each run as a Turn of their own, in the order sent", async () => {
  const pi = piEngineOn([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  session.send("first");
  session.send("second");
  session.send("third");
  const events = await readTurns(session, 3);
  assert.deepEqual(
    withoutDurations(events.filter((e) => e.type.startsWith("turn_") || e.type === "assistant_text")),
    ["one", "two", "three"].flatMap((text) => [
      { type: "turn_started", cause: "command" },
      { type: "assistant_text", text },
      { type: "turn_ended", outcome: "success" },
    ]),
  );
  assert.equal(pi.faux.state.callCount, 3, "each Command was its own model call, none merged");
  await session.close();
});

test("PiEngine: a Command Pi refuses before any run starts still ends its Turn exactly once, with Pi's reason", async () => {
  const pi = piEngineOn([], { provider: { type: "anthropic", model: "claude-haiku-4-5" }, withFaux: false, signedIn: true });
  const session = await pi.engine.open(openOptions(pi.projectDir));
  await pi.runtime().removeRuntimeApiKey("anthropic");
  session.send("hello");
  session.send("and again");
  const events = await readTurns(session, 2);
  const turns = events.filter((e) => e.type.startsWith("turn_"));
  assert.deepEqual(
    turns.map((e) => (e.type === "turn_ended" ? e.outcome : e.type)),
    ["turn_started", "error", "turn_started", "error"],
  );
  const ended = turns[1] as Extract<EngineEvent, { type: "turn_ended" }>;
  assert.match(ended.errors?.join("\n") ?? "", /anthropic/i);
  await session.close();
});

test("PiEngine: a Command stopped while queued never reaches Pi, and the next one runs normally", async () => {
  const model = answeringByPrompt((prompt) =>
    prompt === "keep going" ? untilAborted : fauxAssistantMessage("after the stop"),
  );
  const pi = piEngineOn(model.steps);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  const it = session.events[Symbol.asyncIterator]();
  session.send("keep going");
  for (;;) if ((await it.next()).value?.type === "turn_started") break;
  session.send("queued behind it");
  session.stop();
  session.send("after");
  const events: EngineEvent[] = [];
  while (events.filter((e) => e.type === "turn_ended").length < 3) events.push((await it.next()).value);
  assert.deepEqual(
    withoutDurations(events.filter((e) => e.type.startsWith("turn_") || e.type === "assistant_text")),
    [
      { type: "turn_ended", outcome: "stopped" },
      { type: "turn_started", cause: "command" },
      { type: "turn_ended", outcome: "stopped" },
      { type: "turn_started", cause: "command" },
      { type: "assistant_text", text: "after the stop" },
      { type: "turn_ended", outcome: "success" },
    ],
  );
  assert.equal(model.prompts.includes("queued behind it"), false);
  await session.close();
});

const STEER = "Stop the remaining steps. Reply with just the word PINEAPPLE.";

test("PiEngine: a Steer lets the running tool call finish, then cuts the Turn there and runs the Steer next", async () => {
  const model = answeringByPrompt((prompt) => {
    if (prompt === STEER) return fauxAssistantMessage("PINEAPPLE");
    return fauxAssistantMessage("never reached");
  });
  const pi = piEngineOn([
    fauxAssistantMessage(fauxToolCall("bash", { command: "echo step1" }, { id: "call-1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.3 && echo step2" }, { id: "call-2" }), {
      stopReason: "toolUse",
    }),
    ...model.steps,
  ]);
  assert.equal(pi.engine.capabilities.steer, true);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  const it = session.events[Symbol.asyncIterator]();
  session.send("Run five steps.");
  const events: EngineEvent[] = [];
  for (;;) {
    const event = (await it.next()).value as EngineEvent;
    events.push(event);
    if (event.type === "tool_use" && event.toolUseId === "call-2") break;
  }
  session.steer(STEER);
  while (events.filter((e) => e.type === "turn_ended").length < 2) events.push((await it.next()).value);
  const shown = events.flatMap((e) => {
    if (e.type === "tool_use") return [`${e.type}:${e.toolUseId}`];
    if (e.type === "tool_result") return [`${e.type}:${e.text?.trim()}`];
    if (e.type === "turn_started") return [`turn_started:${e.cause}`];
    if (e.type === "turn_ended") return [`turn_ended:${e.outcome}`];
    if (e.type === "assistant_text") return [e.text];
    return [];
  });
  assert.deepEqual(shown, [
    "turn_started:command",
    "tool_use:call-1",
    "tool_result:step1",
    "tool_use:call-2",
    "tool_result:step2",
    "turn_ended:success",
    "turn_started:steer",
    "PINEAPPLE",
    "turn_ended:success",
  ]);
  assert.deepEqual(model.prompts, [STEER], "the model's next call after step 2 was the Steer");
  await session.close();
});

test("PiEngine: steer() throws when no Turn is running, so a Steer is never prepended to the next Turn", async () => {
  const model = answeringByPrompt((prompt) => fauxAssistantMessage(`answered ${prompt}`));
  const pi = piEngineOn(model.steps);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  assert.throws(() => session.steer("too early"), /no running Turn/);
  session.send("first");
  await readTurns(session, 1);
  assert.throws(() => session.steer("too late"), /no running Turn/);
  session.send("second");
  await readTurns(session, 1);
  assert.deepEqual(model.prompts, ["first", "second"]);
  await session.close();
});

test("PiEngine: Stop right after a Steer ends the Turn and the Steer with it, and the Steer never reaches the model", async () => {
  const model = answeringByPrompt((prompt) => fauxAssistantMessage(`answered ${prompt}`));
  const pi = piEngineOn([
    fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.3" }, { id: "call-1" }), { stopReason: "toolUse" }),
    ...model.steps,
  ]);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  const it = session.events[Symbol.asyncIterator]();
  session.send("go");
  for (;;) if ((await it.next()).value?.type === "tool_use") break;
  session.steer("a correction");
  session.stop();
  session.send("after");
  const events: EngineEvent[] = [];
  while (events.filter((e) => e.type === "turn_ended").length < 3) events.push((await it.next()).value);
  assert.deepEqual(
    events
      .filter((e) => e.type.startsWith("turn_"))
      .map((e) => (e.type === "turn_started" ? e.cause : (e as { outcome: string }).outcome)),
    ["stopped", "steer", "stopped", "command", "success"],
    "the Steer is reported as stopped, so whoever sent it hears how it ended",
  );
  assert.deepEqual(model.prompts, ["after"], "the Steer was not prepended to the next Command");
  await session.close();
});

test("PiEngine: the Conversation is kept in the developer's own Pi session storage", async () => {
  const pi = piEngineOn([fauxAssistantMessage("hi")]);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  session.send("hello");
  const events = await readTurns(session, 1);
  await session.close();
  const conversation = events.find((e) => e.type === "conversation") as Extract<EngineEvent, { type: "conversation" }>;
  assert.equal(conversation.resumed, false);
  const file = SessionManager.findById(pi.projectDir, conversation.id);
  assert.ok(file?.startsWith(process.env.PI_CODING_AGENT_DIR!), `found in Pi's home: ${file}`);
});

async function runConnector(
  pi: ReturnType<typeof piEngineOn>,
  resume: string | undefined,
  commands: string[],
): Promise<EngineEvent[]> {
  const session = await pi.engine.open({ ...openOptions(pi.projectDir), ...(resume ? { resume } : {}) });
  for (const command of commands) session.send(command);
  const events = commands.length ? await readTurns(session, commands.length) : [];
  await session.close();
  for await (const event of session.events) events.push(event);
  return events;
}

function conversationOf(events: EngineEvent[]): Extract<EngineEvent, { type: "conversation" }> | undefined {
  return events.find((e) => e.type === "conversation") as Extract<EngineEvent, { type: "conversation" }> | undefined;
}

test("PiEngine: a restart resumes the same Conversation, with everything said in it", async () => {
  const model = answeringByPrompt(() => fauxAssistantMessage("noted"));
  const pi = piEngineOn(model.steps);
  const first = conversationOf(await runConnector(pi, undefined, ["the codeword is ZEBRA"]))!;
  let seen: string[] = [];
  pi.faux.setResponses([
    (context) => {
      seen = context.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
      return fauxAssistantMessage("ZEBRA");
    },
  ]);
  const events = await runConnector(pi, first.id, ["what's the codeword?"]);
  assert.deepEqual(conversationOf(events), { type: "conversation", id: first.id, resumed: true });
  assert.ok(seen.some((m) => m.includes("the codeword is ZEBRA")), `the model saw the earlier Command: ${seen}`);
});

test("PiEngine: a Conversation missing from Pi's storage opens fresh, reported as lost", async () => {
  const pi = piEngineOn([fauxAssistantMessage("hi")]);
  const events = await runConnector(pi, "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", ["hello"]);
  const conversation = conversationOf(events)!;
  assert.equal(conversation.resumed, false);
  assert.equal(conversation.lostPrevious, true);
  assert.notEqual(conversation.id, "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b");
  assert.ok(SessionManager.findById(pi.projectDir, conversation.id), "the fresh Conversation is in Pi's storage");
});

test("PiEngine: a Conversation that never got a message is not recorded, so a restart starts fresh, not lost", async () => {
  const pi = piEngineOn([fauxAssistantMessage("hi")]);
  const neverMessaged = await runConnector(pi, undefined, []);
  assert.equal(conversationOf(neverMessaged), undefined, "no id to resume is handed over before Pi has one on disk");
  const conversation = conversationOf(await runConnector(pi, undefined, ["hello"]))!;
  assert.equal(conversation.resumed, false);
  assert.equal(conversation.lostPrevious, undefined);
});

test("PiEngine: a lost Conversation stays reported as lost until the fresh one gets a message", async () => {
  const pi = piEngineOn([fauxAssistantMessage("hi")]);
  const lost = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  assert.equal(conversationOf(await runConnector(pi, lost, [])), undefined);
  const conversation = conversationOf(await runConnector(pi, lost, ["hello"]))!;
  assert.equal(conversation.lostPrevious, true);
});

test("PiEngine: open() never throws because the Conversation to resume is missing or malformed", async () => {
  const pi = piEngineOn([]);
  for (const resume of ["not-a-pi-id", "../../escape", ""]) {
    const session = await pi.engine.open({ ...openOptions(pi.projectDir), resume });
    await session.close();
  }
});

test("PiEngine: no user or project Pi extension loads inside the connector", async () => {
  const pi = piEngineOn([fauxAssistantMessage("hi")]);
  const marker = join(pi.projectDir, "extension-loaded");
  const extension = `import { writeFileSync } from "node:fs"; export default function () { writeFileSync(${JSON.stringify(marker)}, "x"); }`;
  for (const dir of [join(process.env.PI_CODING_AGENT_DIR!, "extensions"), join(pi.projectDir, ".pi", "extensions")]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "marker.ts"), extension);
  }
  const session = await pi.engine.open(openOptions(pi.projectDir));
  session.send("hello");
  await readTurns(session, 1);
  await session.close();
  assert.equal(existsSync(marker), false);
});

test("PiEngine: verify() passes when Pi has the configured model and a credential for it", async () => {
  await piEngineOn([]).engine.verify();
});

test("PiEngine: verify() refuses when Pi has no model at all, naming the setting that fixes it", async () => {
  writePiSettings({});
  const pi = piEngineOn([], { provider: { type: "anthropic" }, withFaux: false });
  await assert.rejects(pi.engine.verify(), /no model.*provider\.model/is);
});

test("PiEngine: verify() refuses a configured model Pi doesn't know on that provider", async () => {
  const pi = piEngineOn([], { provider: { type: "anthropic", model: "no-such-model" } });
  await assert.rejects(pi.engine.verify(), /'no-such-model'.*anthropic.*provider\.model/is);
});

test("PiEngine: verify() refuses when Pi has no credential for the model's provider, saying how to sign in", async () => {
  const pi = piEngineOn([], { provider: { type: "copilot", model: FAUX_MODEL }, piProvider: "github-copilot" });
  await pi.engine.verify();
  const unsigned = piEngineOn([], { provider: { type: "copilot", model: "claude-sonnet-4.6" }, withFaux: false });
  await assert.rejects(unsigned.engine.verify(), /credential.*github-copilot.*\/login/is);
});

test("PiEngine: verify() refuses Pi's default model on a provider the relay doesn't accept, naming it and the fix", async () => {
  writePiSettings({ defaultProvider: "openai", defaultModel: FAUX_MODEL });
  try {
    const pi = piEngineOn([], { provider: { type: "anthropic" }, piProvider: "openai" });
    await assert.rejects(pi.engine.verify(), /'openai'.*provider\.model/is);
  } finally {
    writePiSettings({});
  }
});

test("PiEngine: verify() refuses Pi's default model on a provider other than the configured one", async () => {
  writePiSettings({ defaultProvider: "github-copilot", defaultModel: FAUX_MODEL });
  try {
    const pi = piEngineOn([], { provider: { type: "anthropic" }, piProvider: "github-copilot" });
    await assert.rejects(pi.engine.verify(), /'github-copilot'.*provider\.type.*'anthropic'/is);
  } finally {
    writePiSettings({});
  }
});

test("PiEngine: with no model configured, Pi's own default is used", async () => {
  writePiSettings({ defaultProvider: "anthropic", defaultModel: FAUX_MODEL });
  try {
    const pi = piEngineOn([fauxAssistantMessage("hi")], { provider: { type: "anthropic" } });
    await pi.engine.verify();
    const session = await pi.engine.open(openOptions(pi.projectDir));
    session.send("hello");
    const events = await readTurns(session, 1);
    assert.deepEqual(events.find((e) => e.type === "announce"), {
      type: "announce",
      model: FAUX_MODEL,
      permissionMode: "bypassPermissions",
    });
    await session.close();
  } finally {
    writePiSettings({});
  }
});

test("PiEngine: open() refuses just as verify() does, since Pi's own session creation would not", async () => {
  const pi = piEngineOn([], { provider: { type: "copilot", model: "claude-sonnet-4.6" }, withFaux: false });
  await assert.rejects(pi.engine.open(openOptions(pi.projectDir)), /credential.*github-copilot/is);
});

const WITH_SUBAGENT_MODEL = (model: string): PiProviderConfig => ({
  type: "anthropic",
  model: FAUX_MODEL,
  subagents: { profiles: { review: { model } } },
});

test("PiEngine: verify() passes when every subagent profile's model is one Pi has, with a credential", async () => {
  const pi = piEngineOn([], {
    provider: WITH_SUBAGENT_MODEL(`amazon-bedrock/${FOREIGN_MODEL}`),
    foreignProviders: ["amazon-bedrock"],
  });
  await pi.engine.verify();
});

test("PiEngine: verify() refuses a subagent model Pi doesn't know, naming the profile", async () => {
  const pi = piEngineOn([], { provider: WITH_SUBAGENT_MODEL("anthropic/no-such-model") });
  await assert.rejects(pi.engine.verify(), /provider\.subagents\.profiles\.review.*'anthropic\/no-such-model'.*pi --list-models/is);
});

test("PiEngine: verify() refuses a subagent model not written as provider/id", async () => {
  const pi = piEngineOn([], { provider: WITH_SUBAGENT_MODEL(FAUX_MODEL) });
  await assert.rejects(pi.engine.verify(), /provider\.subagents\.profiles\.review.*provider\/id/is);
});

test("PiEngine: verify() refuses a subagent model on a provider the relay doesn't accept", async () => {
  const pi = piEngineOn([], { provider: WITH_SUBAGENT_MODEL(`openai/${FOREIGN_MODEL}`), foreignProviders: ["openai"] });
  await assert.rejects(pi.engine.verify(), /provider\.subagents\.profiles\.review.*'openai'.*relay doesn't accept/is);
});

test("PiEngine: verify() refuses a subagent model with no credential, saying how to sign in", async () => {
  const pi = piEngineOn([], { provider: WITH_SUBAGENT_MODEL("github-copilot/claude-sonnet-4.6") });
  await assert.rejects(pi.engine.verify(), /provider\.subagents\.profiles\.review.*credential.*github-copilot.*\/login/is);
});

test("PiEngine: open() refuses a bad subagent model just as verify() does", async () => {
  const pi = piEngineOn([], { provider: WITH_SUBAGENT_MODEL("anthropic/no-such-model") });
  await assert.rejects(pi.engine.open(openOptions(pi.projectDir)), /provider\.subagents\.profiles\.review/);
});

const PICK_A_DB: EngineQuestion["questions"] = [
  {
    question: "Which database?",
    header: "Database",
    options: [{ label: "Postgres", description: "the usual" }, { label: "SQLite" }],
    multiSelect: false,
  },
  { question: "Which extras?", options: [{ label: "Auth" }, { label: "Billing" }], multiSelect: true },
];

test("PiEngine: a Question reaches the phone in the neutral shape, and the Answer goes back to Pi, with no tool call shown", async () => {
  const model = callingTools([{ name: "ask_user_question", args: { questions: PICK_A_DB }, id: "ask-1" }]);
  const pi = piEngineOn(model.steps);
  const asked: EngineQuestion[] = [];
  const session = await pi.engine.open({
    projectDir: pi.projectDir,
    onQuestion: async (question) => {
      asked.push(question);
      return { answers: { "Which database?": "SQLite", "Which extras?": "Auth, Billing" }, response: "keep it small" };
    },
  });
  session.send("set it up");
  const events = await readTurns(session, 1);
  assert.deepEqual(asked, [{ toolUseId: "ask-1", questions: PICK_A_DB }]);
  assert.deepEqual(
    events.filter((e) => e.type === "tool_use" || e.type === "tool_result"),
    [],
  );
  const result = model.results().get("ask-1");
  assert.equal(result?.isError, false);
  assert.match(result?.text ?? "", /"Which database\?" = "SQLite"/);
  assert.match(result?.text ?? "", /"Which extras\?" = "Auth, Billing"/);
  assert.match(result?.text ?? "", /keep it small/);
  await session.close();
});

test("PiEngine: two Questions in one tool batch are asked one after the other, never at once", async () => {
  const one = [{ question: "First?", options: [{ label: "yes" }], multiSelect: false }];
  const two = [{ question: "Second?", options: [{ label: "yes" }], multiSelect: false }];
  const model = callingTools([
    { name: "ask_user_question", args: { questions: one }, id: "ask-1" },
    { name: "ask_user_question", args: { questions: two }, id: "ask-2" },
  ]);
  const pi = piEngineOn(model.steps);
  let open = 0;
  let most = 0;
  const session = await pi.engine.open({
    projectDir: pi.projectDir,
    onQuestion: async (question) => {
      most = Math.max(most, ++open);
      await new Promise((resolve) => setTimeout(resolve, 20));
      open--;
      return { answers: { [question.questions[0].question]: "yes" } };
    },
  });
  session.send("ask me twice");
  await readTurns(session, 1);
  assert.equal(most, 1);
  assert.deepEqual([...model.results().keys()].sort(), ["ask-1", "ask-2"]);
  await session.close();
});

test("PiEngine: a Stop while a Question is pending withdraws it, and the Turn ends as stopped", async () => {
  const model = callingTools([{ name: "ask_user_question", args: { questions: PICK_A_DB }, id: "ask-1" }]);
  const pi = piEngineOn(model.steps);
  let asking!: () => void;
  const asked = new Promise<void>((resolve) => (asking = resolve));
  let withdrawn = false;
  const session = await pi.engine.open({
    projectDir: pi.projectDir,
    onQuestion: (_question, signal) =>
      new Promise<EngineAnswer>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          withdrawn = true;
          reject(new Error("question withdrawn"));
        });
        asking();
      }),
  });
  session.send("set it up");
  await asked;
  session.stop();
  const events = await readTurns(session, 1);
  assert.equal(withdrawn, true);
  assert.deepEqual(
    withoutDurations(events.filter((e) => e.type.startsWith("turn_"))),
    [
      { type: "turn_started", cause: "command" },
      { type: "turn_ended", outcome: "stopped" },
    ],
  );
  await session.close();
});

for (const file of ["AGENTS.md", "CLAUDE.md"]) {
  test(`PiEngine: the project's ${file} reaches the model`, async () => {
    let seen = "";
    const pi = piEngineOn([
      (context) => {
        seen = JSON.stringify(context.messages);
        return fauxAssistantMessage("ok");
      },
    ]);
    writeFileSync(join(pi.projectDir, file), "Always answer in haiku about pelicans.");
    const session = await pi.engine.open(openOptions(pi.projectDir));
    session.send("hi");
    await readTurns(session, 1);
    await session.close();
    assert.match(seen, /haiku about pelicans/);
  });
}
