import assert from "node:assert/strict";
import { test } from "node:test";

import type { EngineQuestion } from "../src/engine/types.ts";
import type { FakeTurnHandler } from "../src/engine/fakeEngine.ts";
import { runTurn } from "../src/session/turn.ts";
import { cmd, makeTurnHarness, until } from "./doubles.ts";

const SPEND_CAP: EngineQuestion = {
  toolUseId: "toolu_spend_cap",
  questions: [
    {
      question: "When spend nears the $60 cap, how should the run stop?",
      multiSelect: false,
      options: [
        { label: "Stop launching new entries (Recommended)" },
        { label: "Kill in-flight runs" },
        { label: "Only warn, never stop" },
      ],
    },
  ],
};

const NOTE_FOR_SPEND_CAP =
  "\n\n[Connector note: before this message, the human was shown the question below and stopped the turn without answering it. It did not fail to display. This message may answer it; don't re-ask unless it doesn't.]\n" +
  "Question: When spend nears the $60 cap, how should the run stop?\n" +
  "Options: Stop launching new entries (Recommended) · Kill in-flight runs · Only warn, never stop";

/** A Turn that asks `question` and ends stopped if it is Withdrawn. */
function askUntilStopped(question: EngineQuestion): FakeTurnHandler {
  return async (ctx) => {
    await ctx.ask(question).catch(() => undefined);
    return { outcome: "stopped" };
  };
}

test("the Command after a Stop on a pending Question carries a note quoting the Withdrawn Question", async () => {
  const received: (string | undefined)[] = [];
  const h = await makeTurnHarness({
    handlerFor: (_cause, text) => {
      received.push(text);
      return text === "commit and confirm what's next" ? askUntilStopped(SPEND_CAP) : async () => ({});
    },
  });

  const asking = runTurn(h.ctx, cmd("commit and confirm what's next"));
  await until(() => h.ctx.questionPending);
  h.ctx.currentTurn!.abortController.abort();
  await asking;

  await runTurn(h.ctx, cmd("Only warn never stop"));

  assert.deepEqual(received, ["commit and confirm what's next", "Only warn never stop" + NOTE_FOR_SPEND_CAP]);
  await h.close();
});

test("a slash command leaves the note for the next Command, which uses it up", async () => {
  const received: (string | undefined)[] = [];
  const h = await makeTurnHarness({
    handlerFor: (_cause, text) => {
      received.push(text);
      return text === "commit and confirm what's next" ? askUntilStopped(SPEND_CAP) : async () => ({});
    },
  });

  const asking = runTurn(h.ctx, cmd("commit and confirm what's next"));
  await until(() => h.ctx.questionPending);
  h.ctx.currentTurn!.abortController.abort();
  await asking;

  await runTurn(h.ctx, cmd(" /Compact"));
  await runTurn(h.ctx, cmd("Only warn never stop"));
  await runTurn(h.ctx, cmd("what's next?"));

  assert.deepEqual(received.slice(1), [" /Compact", "Only warn never stop" + NOTE_FOR_SPEND_CAP, "what's next?"]);
  await h.close();
});

test("a Command that Steers into a Turn the Engine started on its own carries the note", async () => {
  const received: { cause: string; text: string | undefined }[] = [];
  const h = await makeTurnHarness({
    handlerFor: (cause, text) => {
      received.push({ cause, text });
      if (cause === "engine") {
        return async (ctx) => {
          ctx.emit({ type: "assistant_text", text: "picking back up" });
          await ctx.waitForInterruption();
          return { outcome: "success" };
        };
      }
      return text === "commit and confirm what's next" ? askUntilStopped(SPEND_CAP) : async () => ({});
    },
  });

  const asking = runTurn(h.ctx, cmd("commit and confirm what's next"));
  await until(() => h.ctx.questionPending);
  h.ctx.currentTurn!.abortController.abort();
  await asking;

  h.session.triggerEngineTurn();
  await until(() => h.ctx.eventBuffer.some((e) => e.text === "picking back up"));
  await runTurn(h.ctx, cmd("Only warn never stop"));

  assert.deepEqual(received.slice(1), [
    { cause: "engine", text: undefined },
    { cause: "steer", text: "Only warn never stop" + NOTE_FOR_SPEND_CAP },
  ]);
  await h.close();
});

test("a Question the connector asks itself leaves no note when a Stop Withdraws it", async () => {
  const received: (string | undefined)[] = [];
  const modelPicker: EngineQuestion = {
    toolUseId: "connector-question-1",
    questions: [{ question: "Which model?", multiSelect: false, options: [{ label: "GPT-5" }, { label: "Sonnet 5.5" }] }],
  };
  const h = await makeTurnHarness({
    handlerFor: (_cause, text) => {
      received.push(text);
      return text === "/model" ? askUntilStopped(modelPicker) : async () => ({});
    },
  });

  const asking = runTurn(h.ctx, cmd("/model"));
  await until(() => h.ctx.questionPending);
  h.ctx.currentTurn!.abortController.abort();
  await asking;

  await runTurn(h.ctx, cmd("carry on"));

  assert.deepEqual(received, ["/model", "carry on"]);
  await h.close();
});

test("a note for several Withdrawn questions lists each of them", async () => {
  const received: (string | undefined)[] = [];
  const jobsAndBuild: EngineQuestion = {
    toolUseId: "toolu_jobs_and_build",
    questions: [
      {
        question: "Which 4 jobs should I queue in eng?",
        multiSelect: false,
        options: [{ label: "First 4 of heavy6" }, { label: "I'll name them" }],
      },
      {
        question: "Which build should the jobs be pinned to?",
        multiSelect: false,
        options: [{ label: "1.2.0-2901" }, { label: "1.1.0-2906" }],
      },
    ],
  };
  const h = await makeTurnHarness({
    handlerFor: (_cause, text) => {
      received.push(text);
      return text === "queue up 4 jobs in eng" ? askUntilStopped(jobsAndBuild) : async () => ({});
    },
  });

  const asking = runTurn(h.ctx, cmd("queue up 4 jobs in eng"));
  await until(() => h.ctx.questionPending);
  h.ctx.currentTurn!.abortController.abort();
  await asking;

  await runTurn(h.ctx, cmd("heavy6, 2901"));

  assert.equal(
    received[1],
    "heavy6, 2901\n\n" +
      "[Connector note: before this message, the human was shown the questions below and stopped the turn without answering them. It did not fail to display. This message may answer them; don't re-ask unless it doesn't.]\n" +
      "Question: Which 4 jobs should I queue in eng?\n" +
      "Options: First 4 of heavy6 · I'll name them\n" +
      "Question: Which build should the jobs be pinned to?\n" +
      "Options: 1.2.0-2901 · 1.1.0-2906",
  );
  await h.close();
});
