import { randomUUID } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { SkillInfo } from "../relay/client";
import type { TurnCause } from "../session/context";
import {
  FakeEngine,
  type FakeEngineScript,
  type FakeTurnContext,
  type FakeTurnHandler,
  type FakeTurnOutcome,
} from "./fakeEngine";

/**
 * Scripted Engines for the e2e harness, selected by name through
 * `CRC_FAKE_ENGINE` (see session/loop.ts). Each plays neutral Engine events
 * instead of driving a real, model-backed agent, so the e2e tests built
 * against them spend no model call -- and, since they sit at the Engine seam,
 * exercise everything above it exactly as a real Engine would.
 */

/** What every persona's Turn reports as its context-window fill. */
const FAKE_CONTEXT_PERCENTAGE = 42;

/**
 * Every persona's Turn ends like this. Real token counts, not zeros: the
 * relay rejects a `usage` event missing any of them, and a rejected batch is
 * retried forever, wedging the whole event stream.
 */
const FINISHED: FakeTurnOutcome = {
  outcome: "success",
  contextPercentage: FAKE_CONTEXT_PERCENTAGE,
  usage: {
    inputTokens: 120,
    outputTokens: 45,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    // 0.01 rather than 0.0001: the phone's divider shows cost to 2 decimals,
    // and smaller rounds to "$0.00", which smoke.spec.ts reads as no cost.
    costUsd: 0.01,
  },
};

/**
 * Long enough that the phone's divider, which shows duration to a tenth of a
 * second, never reads "0.0s" -- the fake's Turns otherwise take a millisecond,
 * and smoke.spec.ts reads that as no duration at all.
 */
const MIN_TURN_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ends a Turn the way every persona does, after at least {@link MIN_TURN_MS}. */
async function finish(): Promise<FakeTurnOutcome> {
  await sleep(MIN_TURN_MS);
  return FINISHED;
}

function toolCall(ctx: FakeTurnContext, name: string, input: unknown, result: string): void {
  const toolUseId = `toolu_${randomUUID()}`;
  ctx.emit({ type: "tool_use", toolUseId, name, input });
  ctx.emit({ type: "tool_result", toolUseId, text: result, isError: false });
}

/**
 * Stands in for smoke.spec.ts's real Turns: writes or appends to
 * e2e-proof.txt in the project directory itself (a real agent does this, not
 * the connector), then reports it the way a model would -- as a tool call
 * the transcript can render, not just a claim in text.
 */
function smoke(projectDir: string): FakeEngineScript["handlerFor"] {
  return (_cause, text) => async (ctx) => {
    const filePath = join(projectDir, "e2e-proof.txt");
    if (text?.includes("Create a file named e2e-proof.txt")) {
      await writeFile(filePath, "e2e ok\n", "utf-8");
      toolCall(ctx, "Write", { file_path: filePath, content: "e2e ok\n" }, "File created successfully.");
      ctx.emit({ type: "assistant_text", text: "DONE" });
    } else if (text?.includes("Append a second line")) {
      await appendFile(filePath, "turn two ok\n", "utf-8");
      toolCall(
        ctx,
        "Edit",
        { file_path: filePath, old_string: "e2e ok\n", new_string: "e2e ok\nturn two ok\n" },
        "File updated successfully.",
      );
      ctx.emit({ type: "assistant_text", text: "done" });
    } else {
      ctx.emit({ type: "assistant_text", text: "ok" });
    }
    return finish();
  };
}

/**
 * Stands in for event-batching.spec.ts's long multi-tool Turn: 30 tool
 * call/result pairs, which is what that test needs to exceed the relay's
 * 25-event batch cap.
 */
const multiToolTurn: FakeTurnHandler = async (ctx) => {
  for (let n = 1; n <= 30; n++) toolCall(ctx, "Bash", { command: `echo batch-${n}` }, `batch-${n}`);
  ctx.emit({ type: "assistant_text", text: "BATCHDONE" });
  return finish();
};

const LOCAL_COMMANDS: SkillInfo[] = [
  { name: "clear", description: "Clear conversation history", argumentHint: "" },
  { name: "compact", description: "Compact the conversation", argumentHint: "" },
];

/** Answers `/clear` and `/compact` the way a real Engine reports them; anything else gets a plain reply. */
function localCommands(_cause: TurnCause, text: string | undefined): FakeTurnHandler {
  return async (ctx) => {
    const command = text?.trim();
    if (command === "/clear") {
      ctx.emit({ type: "status", text: "Conversation cleared." });
      ctx.emit({ type: "status", text: "conversation cleared" });
    } else if (command === "/compact") {
      ctx.emit({ type: "status", text: "Compacted the conversation." });
      ctx.emit({
        type: "compacted",
        preTokens: 12000,
        postTokens: 3000,
        contextPercentage: FAKE_CONTEXT_PERCENTAGE,
      });
    } else {
      ctx.emit({ type: "assistant_text", text: "ok" });
    }
    return finish();
  };
}

/**
 * Asks one Question, the way Grill Me would, and waits for the Answer.
 * Any Command triggers it -- these tests don't exercise a model's own
 * judgement about when to ask.
 */
const askUserQuestion: FakeTurnHandler = async (ctx) => {
  await ctx.ask({
    toolUseId: `toolu_${randomUUID()}`,
    questions: [
      {
        question: "Which approach should we take?",
        header: "Approach",
        options: [
          { label: "Option A", description: "The first way." },
          { label: "Option B", description: "The second way." },
        ],
        multiSelect: false,
      },
    ],
  });
  ctx.emit({ type: "assistant_text", text: "Thanks, got it." });
  return finish();
};

/**
 * Starts one Background shell task and ends the Turn *before* the task
 * settles, the way a real one outlives the Turn that started it -- the phone
 * should get its composer back while the task's card still spins.
 */
const backgroundTasks: FakeTurnHandler = async (ctx) => {
  const toolUseId = `toolu_${randomUUID()}`;
  const taskId = `task_${randomUUID()}`;
  const description = "sleep 30 && echo done";

  ctx.emit({ type: "tool_use", toolUseId, name: "Bash", input: { command: description, run_in_background: true } });
  ctx.emit({ type: "tool_result", toolUseId, text: "Command running in the background.", isError: false });
  ctx.emit({ type: "task_started", taskId, toolUseId, description, taskType: "shell", ambient: false });
  ctx.emit({ type: "tasks_changed", tasks: [{ taskId, taskType: "shell", description }] });
  ctx.emit({ type: "assistant_text", text: "Kicked off a background job." });

  // Comfortably longer than the phone's 2s event poll, so the task is
  // observably running on the phone for at least one poll cycle rather than
  // started and settled collapsing into a single batch it never catches.
  void sleep(6000).then(() => {
    ctx.emit({ type: "task_settled", taskId, toolUseId, status: "completed", summary: "done", durationMs: 1234, ambient: false });
    ctx.emit({ type: "tasks_changed", tasks: [] });
  });
  return finish();
};

// Comfortably longer than the connector's Steer-poll interval (1s) plus the
// round trip a test needs to *observe* a step has run before it can act --
// the relay flush (750ms) and the phone's own event poll (2s) sit between
// "the persona is paused" and "a test script can tell." Too short a window
// here doesn't fail loudly; it just makes a Steer arrive a moment too late
// and silently exercises the un-steered path instead.
const STEER_PAUSE_MS = 8000;

// The original Command works through this many steps before finishing if
// nothing Steers it -- enough to prove a Steer mid-sequence really abandons a
// step that would otherwise have run (never-emitted "step-2" text is what
// the specs check for). A Turn replying to a Steer gets only one step: enough
// to be genuinely working and reachable by a further Steer, without making
// every hand-back test wait out a multi-step cool-down.
const FIRST_TURN_STEPS = 2;
const REPLY_TURN_STEPS = 1;

/**
 * Works through `steps` tool calls, pausing after each long enough for a
 * Steer to land. A Steer or a Stop cuts the work off at that tool-call
 * boundary -- no further step runs, and nothing more is said -- exactly as a
 * real Engine truncates a Turn.
 */
async function steppedWork(ctx: FakeTurnContext, steps: number): Promise<FakeTurnOutcome> {
  const interrupted = ctx.waitForInterruption().then(() => "interrupted" as const);
  for (let step = 1; step <= steps; step++) {
    toolCall(ctx, "Bash", { command: `echo step-${step}` }, `step-${step}`);
    const paused = sleep(STEER_PAUSE_MS).then(() => "done" as const);
    if ((await Promise.race([paused, interrupted])) === "interrupted") {
      return ctx.stopped ? { outcome: "stopped" } : { outcome: "success" };
    }
  }
  ctx.emit({ type: "assistant_text", text: "finished without being steered further" });
  return finish();
}

/** A Turn that works through a sequence of steps a Steer can land on; each Steer's own Turn announces it, then works on. */
function steering(cause: TurnCause, text: string | undefined): FakeTurnHandler {
  return async (ctx) => {
    if (cause === "steer") {
      ctx.emit({ type: "assistant_text", text: `steered: ${text}` });
      return steppedWork(ctx, REPLY_TURN_STEPS);
    }
    return steppedWork(ctx, FIRST_TURN_STEPS);
  };
}

/**
 * Asks a Question first, then -- once Answered -- works through steps a
 * Steer can land on. Exercises "a Command sent during the Question steers
 * the Turn normally once the Answer releases it": the Question and the steps
 * are two phases of one Turn, and only the second can be Steered.
 */
function steeringWithQuestion(cause: TurnCause, text: string | undefined): FakeTurnHandler {
  if (cause === "steer") return steering(cause, text);
  return async (ctx) => {
    await ctx.ask({
      toolUseId: `toolu_${randomUUID()}`,
      questions: [
        {
          question: "Proceed?",
          header: "Confirm",
          options: [{ label: "Yes", description: "Go ahead." }],
          multiSelect: false,
        },
      ],
    });
    return steppedWork(ctx, FIRST_TURN_STEPS);
  };
}

/**
 * Holds a Steer before confirming it with the Steer's own Turn, widening the
 * connector's normally sub-millisecond window between claiming a Steer and
 * the Engine confirming it, so a test can land a Stop inside it reliably.
 * "holding before confirm" is said the instant the Steer lands, so a test
 * waits for that rather than guessing from the clock when the hold began.
 */
async function holdBeforeConfirm(ctx: FakeTurnContext): Promise<void> {
  ctx.emit({ type: "assistant_text", text: "holding before confirm" });
  // Long enough that a test can observe that text on the phone -- itself a
  // relay flush plus an event poll after it was said -- and still click Stop
  // with room to spare.
  await Promise.race([sleep(6000), ctx.waitForStop()]);
}

const ANNOUNCE = { model: "fake-model", permissionMode: "bypassPermissions" };

function script(
  handlerFor: FakeEngineScript["handlerFor"],
  extra: Partial<FakeEngineScript> = {},
): FakeEngineScript {
  return {
    announce: ANNOUNCE,
    menu: { skills: [], localCommands: [] },
    handlerFor,
    ...extra,
  };
}

/** The persona named `name`, as a fresh FakeEngine whose Turns work in `projectDir`. */
export function fakeEnginePersona(name: string, projectDir: string): FakeEngine {
  switch (name) {
    case "smoke":
      return new FakeEngine(script(smoke(projectDir)));
    case "multi-tool-turn":
      return new FakeEngine(script(() => multiToolTurn));
    case "local-commands":
      return new FakeEngine(
        script(localCommands, { menu: { skills: [], localCommands: LOCAL_COMMANDS } }),
      );
    case "ask-user-question":
      return new FakeEngine(script(() => askUserQuestion));
    case "background-tasks":
      return new FakeEngine(script(() => backgroundTasks));
    case "steering":
      return new FakeEngine(script(steering));
    case "steering-with-question":
      return new FakeEngine(script(steeringWithQuestion));
    case "steering-slow-confirm":
      return new FakeEngine(script(steering, { beforeSteerConfirm: holdBeforeConfirm }));
    case "signed-out":
      // An Engine nobody is signed in to: startup must fail before a phone URL.
      return new FakeEngine(
        script(smoke(projectDir), { failVerify: new Error("Not logged in. Run `copilot login`.") }),
      );
    default:
      throw new Error(`Unknown CRC_FAKE_ENGINE persona: '${name}'`);
  }
}
