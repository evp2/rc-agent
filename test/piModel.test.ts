import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fauxAssistantMessage,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";

import type {
  EngineAnswer,
  EngineEvent,
  EngineQuestion,
  EngineSession,
} from "../src/engine/types.ts";
import { FAUX_MODEL, FOREIGN_MODEL, piEngineOn } from "./piDoubles.ts";

type Pi = ReturnType<typeof piEngineOn>;
type Ended = Extract<EngineEvent, { type: "turn_ended" }>;

const OTHER = "other-model";
const models = {
  model: { reasoning: true },
  otherModels: [{ id: OTHER, reasoning: true }],
};

function reasoningRecorder(): {
  steps: FauxResponseStep[];
  seen: (string | undefined)[];
} {
  const seen: (string | undefined)[] = [];
  const step: FauxResponseStep = (_context, options) => {
    seen.push(options?.reasoning);
    return fauxAssistantMessage("ok");
  };
  return { steps: Array.from({ length: 10 }, () => step), seen };
}

function open(
  pi: Pi,
  answer: (q: EngineQuestion) => string = () => "",
  resume?: string,
) {
  const asked: EngineQuestion[] = [];
  const promise = pi.engine.open({
    projectDir: pi.projectDir,
    ...(resume ? { resume } : {}),
    onQuestion: async (q) => {
      asked.push(q);
      const picked = answer(q);
      return {
        answers: { [q.questions[0].question]: picked },
      } satisfies EngineAnswer;
    },
  });
  return { promise, asked };
}

async function readTurns(
  session: EngineSession,
  count: number,
): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  let ended = 0;
  for await (const event of session.events) {
    events.push(event);
    if (event.type === "turn_ended" && ++ended === count) return events;
  }
  throw new Error(`event stream ended after ${JSON.stringify(events)}`);
}

async function runCommands(
  session: EngineSession,
  commands: string[],
): Promise<EngineEvent[]> {
  for (const c of commands) session.send(c);
  return readTurns(session, commands.length);
}

function lastTurn(events: EngineEvent[]): EngineEvent[] {
  return events.slice(events.findLastIndex((e) => e.type === "turn_started"));
}

const ended = (events: EngineEvent[]) =>
  events.findLast((e) => e.type === "turn_ended") as Ended;

test("PiEngine: /model with a model switches at once, re-announces it and says so", async () => {
  const pi = piEngineOn([], models);
  const { promise } = open(pi);
  const session = await promise;
  const events = await runCommands(session, [`/model ${OTHER}`]);
  await session.close();

  const turn = lastTurn(events);
  assert.deepEqual(
    turn.map((e) => e.type),
    ["turn_started", "announce", "status", "turn_ended"],
  );
  assert.deepEqual(turn[1], {
    type: "announce",
    model: OTHER,
    permissionMode: (turn[1] as { permissionMode: string }).permissionMode,
  });
  assert.match(
    (turn[2] as { text: string }).text,
    /^model set to .*other-model/,
  );
  assert.equal(ended(events).outcome, "success");
});

test("PiEngine: /model with a model and an effort sets both", async () => {
  const rec = reasoningRecorder();
  const pi = piEngineOn(rec.steps, models);
  const session = await open(pi).promise;
  const events = await runCommands(session, [`/model ${OTHER} low`, "hello"]);
  await session.close();

  assert.equal(
    events
      .filter((e) => e.type === "turn_ended")
      .every((e) => (e as Ended).outcome === "success"),
    true,
  );
  assert.deepEqual(rec.seen, ["low"]);
});

test("PiEngine: /model with no argument asks for a model, then an effort", async () => {
  const rec = reasoningRecorder();
  const pi = piEngineOn(rec.steps, models);
  const { promise, asked } = open(pi, (q) =>
    q.questions[0].header === "Model" ? OTHER : "high",
  );
  const session = await promise;
  await runCommands(session, ["/model", "hello"]);
  await session.close();

  assert.deepEqual(
    asked.map((q) => q.questions[0].header),
    ["Model", "Effort"],
  );
  const modelOptions = asked[0].questions[0].options.map((o) => o.label);
  assert.deepEqual(modelOptions.sort(), [FAUX_MODEL, OTHER]);
  assert.ok(asked[1].questions[0].options.some((o) => o.label === "high"));
  assert.deepEqual(rec.seen, ["high"]);
});

test("PiEngine: /model offers and accepts only models on the session's provider", async () => {
  const pi = piEngineOn([], { ...models, foreignProviders: ["openai"] });
  const { promise, asked } = open(pi, () => FOREIGN_MODEL);
  const session = await promise;
  const events = await runCommands(session, [
    `/model ${FOREIGN_MODEL}`,
    "/model",
  ]);
  await session.close();

  const turns = events.filter((e) => e.type === "turn_ended") as Ended[];
  assert.equal(turns[0].outcome, "error");
  assert.match(turns[0].errors![0], /foreign-model/);
  assert.match(turns[0].errors![0], /another provider/);
  assert.match(turns[0].errors![0], /stays on anthropic/);
  assert.ok(
    !events.some((e) => e.type === "announce" && e.model === FOREIGN_MODEL),
  );
  assert.ok(
    !asked[0].questions[0].options.some((o) => o.label === FOREIGN_MODEL),
  );
  assert.equal(
    turns[1].outcome,
    "error",
    "an answer naming a model that isn't offered is refused",
  );
});

test("PiEngine: /model refuses an unknown model and an effort the model lacks, switching nothing", async () => {
  const rec = reasoningRecorder();
  const pi = piEngineOn(rec.steps, models);
  const session = await open(pi).promise;
  const events = await runCommands(session, [
    "/model nonesuch",
    `/model ${OTHER} turbo`,
    "hello",
  ]);
  await session.close();

  const turns = events.filter((e) => e.type === "turn_ended") as Ended[];
  assert.equal(turns[0].outcome, "error");
  assert.match(turns[0].errors![0], /nonesuch/);
  assert.equal(turns[1].outcome, "error");
  assert.match(turns[1].errors![0], /turbo/);
  assert.ok(!events.some((e) => e.type === "announce" && e.model === OTHER));
});

test("PiEngine: /effort with a level sets it; with none asks among the current model's levels", async () => {
  const rec = reasoningRecorder();
  const pi = piEngineOn(rec.steps, models);
  const { promise, asked } = open(pi, () => "medium");
  const session = await promise;
  const events = await runCommands(session, [
    "/effort low",
    "hello",
    "/effort",
    "hello",
  ]);
  await session.close();

  assert.deepEqual(rec.seen, ["low", "medium"]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].questions[0].header, "Effort");
  assert.ok(asked[0].questions[0].options.every((o) => o.label !== "turbo"));
  const statuses = events
    .filter((e) => e.type === "status")
    .map((e) => (e as { text: string }).text);
  assert.deepEqual(statuses, ["effort set to low", "effort set to medium"]);
});

test("PiEngine: /effort on a model with no effort levels is refused", async () => {
  const pi = piEngineOn([], { model: { reasoning: false } });
  const session = await open(pi).promise;
  const events = await runCommands(session, ["/effort high"]);
  await session.close();

  assert.equal(ended(events).outcome, "error");
});

test("PiEngine: /model and /effort wait behind a running Turn and run as their own Turn", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow: FauxResponseStep = async () => {
    await gate;
    return fauxAssistantMessage("late");
  };
  const pi = piEngineOn([slow], models);
  const session = await open(pi).promise;
  session.send("work");
  session.send(`/model ${OTHER}`);
  session.send("/effort low");
  await new Promise((r) => setTimeout(r, 100));
  release();
  const events = await readTurns(session, 3);
  await session.close();

  const shape = events.filter((e) =>
    ["turn_started", "turn_ended", "announce", "status"].includes(e.type),
  );
  const after = shape.slice(shape.findIndex((e) => e.type === "turn_ended"));
  assert.deepEqual(
    after.map((e) => e.type),
    [
      "turn_ended",
      "turn_started",
      "announce",
      "status",
      "turn_ended",
      "turn_started",
      "status",
      "turn_ended",
    ],
  );
});

test("PiEngine: a switched model and effort survive a restart; the config applies only to a fresh Conversation", async () => {
  const rec = reasoningRecorder();
  const pi = piEngineOn(rec.steps, {
    ...models,
    provider: {
      type: "anthropic",
      model: FAUX_MODEL,
      thinkingLevel: "minimal",
    },
  });
  const first = await open(pi).promise;
  const started = await runCommands(first, [`/model ${OTHER} high`, "hello"]);
  await first.close();
  const id = (started.find((e) => e.type === "conversation") as { id: string })
    .id;

  const resumed = await open(pi, () => "", id).promise;
  const events: EngineEvent[] = [];
  for await (const e of resumed.events) {
    events.push(e);
    if (e.type === "menu") break;
  }
  resumed.send("again");
  await readTurns(resumed, 1);
  await resumed.close();

  assert.equal(
    (events.find((e) => e.type === "announce") as { model: string }).model,
    OTHER,
  );
  assert.deepEqual(rec.seen, ["high", "high"]);

  const fresh = await open(pi).promise;
  await runCommands(fresh, ["hi"]);
  await fresh.close();
  assert.equal(rec.seen.at(-1), "minimal");
});

test("PiEngine: a resumed Conversation with no switch recorded takes the config's model and effort", async () => {
  const first = piEngineOn([fauxAssistantMessage("hi")], {
    ...models,
    provider: { type: "anthropic", model: FAUX_MODEL, thinkingLevel: "minimal" },
  });
  const firstSession = await open(first).promise;
  const started = await runCommands(firstSession, ["hello"]);
  await firstSession.close();
  const id = (started.find((e) => e.type === "conversation") as { id: string }).id;

  const rec = reasoningRecorder();
  const second = piEngineOn(rec.steps, {
    ...models,
    provider: { type: "anthropic", model: FAUX_MODEL, thinkingLevel: "high" },
    projectDir: first.projectDir,
  });
  const resumed = await open(second, () => "", id).promise;
  await runCommands(resumed, ["again"]);
  await resumed.close();
  assert.deepEqual(rec.seen, ["high"]);
});

test("PiEngine: the menu lists /model and /effort", async () => {
  const pi = piEngineOn([], models);
  const session = await open(pi).promise;
  let menu: Extract<EngineEvent, { type: "menu" }> | undefined;
  for await (const e of session.events)
    if (e.type === "menu") {
      menu = e;
      break;
    }
  await session.close();
  const names = menu!.localCommands.map((c) => c.name);
  assert.ok(names.includes("model") && names.includes("effort"));
});
