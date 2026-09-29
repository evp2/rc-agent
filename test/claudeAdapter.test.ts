import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { HookInput, McpSdkServerConfigWithInstance, Options } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ClaudeEngine } from "../src/engine/claude/adapter.ts";
import { transcriptPath } from "../src/engine/claude/transcript.ts";
import type {
  EngineAnswer,
  EngineEvent,
  EngineImage,
  EngineQuestion,
  ShowImageOutcome,
} from "../src/engine/types.ts";
import {
  assistantText,
  compactBoundary,
  init,
  initWithSkills,
  result,
  scriptedQuery,
  taskStarted,
} from "./claudeDoubles.ts";
import { runEngineGuaranteeSuite, type EngineGuaranteeHarness } from "./engineGuaranteeSuite.ts";
import { reactiveQuery } from "./engineReactiveQuery.ts";

function noQuestionsExpected() {
  return () => new Promise<EngineAnswer>(() => undefined);
}

const harness: EngineGuaranteeHarness = {
  makeSimpleEngine: () =>
    new ClaudeEngine({ query: reactiveQuery({ subTurns: [[init(), assistantText("hi"), result()]] }), env: {} }),

  makeErroringEngine: () =>
    new ClaudeEngine({
      query: scriptedQuery([init(), assistantText("working"), result()], {
        throwAfter: { count: 2, error: new Error("subprocess exited") },
      }).query,
      env: {},
    }),

  makeHangingEngine: () =>
    new ClaudeEngine({
      query: scriptedQuery([init(), assistantText("working")], { staysOpenAfterDrain: true }).query,
      env: {},
    }),

  makeQueueingEngine: () =>
    new ClaudeEngine({
      query: reactiveQuery({
        subTurns: [
          [init(), assistantText("first"), result()],
          [init("sdk-2"), assistantText("second"), result()],
        ],
      }),
      env: {},
    }),

  makeSteerableEngine: () =>
    new ClaudeEngine({
      query: reactiveQuery({
        subTurns: [
          [init(), assistantText("first")],
          [init("sdk-2"), assistantText("corrected"), result()],
        ],
      }),
      env: {},
    }),

  makeBackgroundTaskEngine: () =>
    new ClaudeEngine({
      query: reactiveQuery({
        subTurns: [[init(), assistantText("starting"), taskStarted("bg-1")]],
        hangAfterLast: true,
      }),
      env: {},
    }),
};

runEngineGuaranteeSuite("ClaudeEngine", harness);

const TIMED_OUT = Symbol("timed out");

async function collect(
  iterator: AsyncIterator<EngineEvent>,
  predicate: (e: EngineEvent) => boolean,
  timeoutMs = 2000,
): Promise<EngineEvent[]> {
  const collected: EngineEvent[] = [];
  for (;;) {
    const raced = await Promise.race([
      iterator.next(),
      new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), timeoutMs)),
    ]);
    if (raced === TIMED_OUT) throw new Error(`timed out; collected: ${JSON.stringify(collected)}`);
    if (raced.done) throw new Error(`stream ended; collected: ${JSON.stringify(collected)}`);
    collected.push(raced.value);
    if (predicate(raced.value)) return collected;
  }
}

// --- Translation tests: existing scripted Claude messages -> neutral events -

test("ClaudeEngine: the context percentage is stamped on turn_ended and on a compaction", async () => {
  const { query } = scriptedQuery([init(), compactBoundary(), result()], { contextPercentages: [55, 77] });
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("/compact");
  const events = await collect(it, (e) => e.type === "turn_ended");

  const compacted = events.find((e) => e.type === "compacted") as Extract<EngineEvent, { type: "compacted" }>;
  const ended = events.find((e) => e.type === "turn_ended") as Extract<EngineEvent, { type: "turn_ended" }>;
  assert.equal(compacted.contextPercentage, 55);
  assert.equal(ended.contextPercentage, 77);
  await session.close();
});

test("ClaudeEngine: a subprocess dying mid-Turn still ends it, with the failure reported once", async () => {
  const { query } = scriptedQuery([init(), assistantText("working"), result()], {
    throwAfter: { count: 2, error: new Error("subprocess exited") },
  });
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("first");
  const events = await collect(it, (e) => e.type === "turn_ended");
  const ended = events.find((e) => e.type === "turn_ended") as Extract<EngineEvent, { type: "turn_ended" }>;
  assert.equal(ended.outcome, "error");
  assert.deepEqual(ended.errors, ["subprocess exited"]);
  await session.close();
});

test("ClaudeEngine: an [ede_diagnostic]-tagged throw is suppressed, not reported as an error", async () => {
  const { query } = scriptedQuery([init(), assistantText("working"), result()], {
    throwAfter: {
      count: 2,
      error: new Error("[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"),
    },
  });
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("first");
  const events = await collect(it, (e) => e.type === "turn_ended");
  const ended = events.find((e) => e.type === "turn_ended") as Extract<EngineEvent, { type: "turn_ended" }>;
  assert.equal(ended.outcome, "success");
  assert.equal(ended.errors, undefined);
  await session.close();
});

test("ClaudeEngine: a duplicate error after an already-reported result is suppressed", async () => {
  const { query } = scriptedQuery(
    [init(), assistantText("working"), result(), assistantText("should not appear"), result("error_during_execution")],
    {
      onYield: async (message) => {
        // Mirrors run.ts's own drain: nothing stops the generator from
        // yielding further messages against an already-finished sub-turn.
        void message;
      },
    },
  );
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("first");
  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.equal(events.filter((e) => e.type === "turn_ended").length, 1, "only the first result's outcome is reported");
});

test("ClaudeEngine: the Question callback replaces the question tool's tool-call event", async () => {
  const toolUseId = "toolu_q1";
  const questionInput = {
    questions: [{ question: "Which approach?", options: [{ label: "A" }, { label: "B" }], multiSelect: false }],
  };
  let capturedOptions: Options | undefined;
  const { query } = scriptedQuery([init()], {
    onOptions: (options) => {
      capturedOptions = options;
    },
  });
  const engine = new ClaudeEngine({
    query,
    env: {},
  });
  let receivedQuestion: EngineQuestion | undefined;
  const session = await engine.open({
    projectDir: "/tmp/x",
    onQuestion: async (q) => {
      receivedQuestion = q;
      return { answers: { [q.questions[0].question]: "A" } };
    },
  });
  const it = session.events[Symbol.asyncIterator]();
  session.send("ask something");
  await collect(it, (e) => e.type === "turn_started");

  // Drives canUseTool exactly as the real SDK would for an AskUserQuestion
  // tool call, using the Options the scripted query captured.
  const permissionResult = await capturedOptions?.canUseTool?.("AskUserQuestion", questionInput, {
    signal: new AbortController().signal,
    toolUseID: toolUseId,
    requestId: "req-1",
  });

  assert.ok(receivedQuestion, "onQuestion was invoked");
  assert.equal(receivedQuestion?.toolUseId, toolUseId);
  assert.deepEqual(receivedQuestion?.questions, questionInput.questions);
  assert.equal(permissionResult?.behavior, "allow");
  await session.close();
});

test("ClaudeEngine: an assistant message's AskUserQuestion tool_use produces no tool_use event", async () => {
  const toolUseId = "toolu_q1";
  const { query } = scriptedQuery([
    init(),
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input: { questions: [] } }],
      },
    } as unknown as Parameters<typeof scriptedQuery>[0][number],
    result(),
  ]);
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({
    projectDir: "/tmp/x",
    onQuestion: async () => ({ answers: {} }),
  });
  const it = session.events[Symbol.asyncIterator]();
  session.send("ask something");
  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.ok(!events.some((e) => e.type === "tool_use"), "the question tool never becomes a tool_use event");
  await session.close();
});

// --- show_image forwards to onShowImage -------------------------------------

/**
 * Opens a session with the given `onShowImage`, starts a Turn, and connects
 * an MCP client to whatever in-process server the adapter handed the SDK --
 * the same protocol the real CLI speaks to it.
 */
async function openWithShowImage(
  onShowImage: (image: EngineImage, signal: AbortSignal) => Promise<ShowImageOutcome>,
): Promise<{ client: Client; close(): Promise<void> }> {
  let capturedOptions: Options | undefined;
  const { query } = scriptedQuery([init()], {
    onOptions: (options) => {
      capturedOptions = options;
    },
  });
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected(), onShowImage });
  const it = session.events[Symbol.asyncIterator]();
  session.send("show me");
  await collect(it, (e) => e.type === "turn_started");

  const servers = Object.values(capturedOptions?.mcpServers ?? {});
  const server = servers.find((s): s is McpSdkServerConfigWithInstance => s.type === "sdk");
  assert.ok(server, "an in-process MCP server was handed to the SDK");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await session.close();
    },
  };
}

test("ClaudeEngine: show_image is registered, and a call reaches onShowImage with its tool-use id", async () => {
  let received: EngineImage | undefined;
  const { client, close } = await openWithShowImage(async (image) => {
    received = image;
    return { shown: true };
  });

  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === "show_image"), "show_image is offered to the Engine");

  const result = await client.callTool({
    name: "show_image",
    arguments: { path: "/tmp/shot.png", caption: "the login page" },
    _meta: { "claudecode/toolUseId": "toolu_img" },
  });

  assert.deepEqual(received, { toolUseId: "toolu_img", path: "/tmp/shot.png", caption: "the login page" });
  assert.equal(result.isError, undefined);
  assert.equal((result.content as { type: string }[])[0].type, "text");
  await close();
});

test("ClaudeEngine: a show_image that fails comes back to the Engine as an error carrying the reason", async () => {
  const { client, close } = await openWithShowImage(async () => ({ shown: false, reason: "not a PNG" }));

  const result = await client.callTool({
    name: "show_image",
    arguments: { path: "/tmp/notes.txt" },
    _meta: { "claudecode/toolUseId": "toolu_img" },
  });

  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: "text", text: "not a PNG" }]);
  await close();
});

test("ClaudeEngine: a show_image call with no tool-use id is refused before it reaches onShowImage", async () => {
  let called = false;
  const { client, close } = await openWithShowImage(async () => {
    called = true;
    return { shown: true };
  });

  const result = await client.callTool({ name: "show_image", arguments: { path: "/tmp/shot.png" } });

  assert.equal(called, false);
  assert.equal(result.isError, true);
  await close();
});

test("ClaudeEngine: a session opened without onShowImage offers no show_image tool", async () => {
  let capturedOptions: Options | undefined;
  const { query } = scriptedQuery([init()], {
    onOptions: (options) => {
      capturedOptions = options;
    },
  });
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("hello");
  await collect(it, (e) => e.type === "turn_started");

  assert.equal(capturedOptions?.mcpServers, undefined);
  await session.close();
});

// --- The PreCompact hook translates to "compacting" -------------------------

test("ClaudeEngine: an automatic PreCompact fires \"compacting\", a manual one does not", async () => {
  let capturedOptions: Options | undefined;
  const { query } = scriptedQuery([init(), compactBoundary(), result()], {
    onOptions: (options) => {
      capturedOptions = options;
    },
  });
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("/compact");
  await collect(it, (e) => e.type === "turn_started");

  const hookInput = { hook_event_name: "PreCompact", trigger: "auto" } as unknown as HookInput;
  await capturedOptions?.hooks?.PreCompact?.[0]?.hooks[0]?.(hookInput, undefined, {
    signal: new AbortController().signal,
  });

  const events = await collect(it, (e) => e.type === "turn_ended");
  assert.ok(events.some((e) => e.type === "compacting" && e.trigger === "auto"));
  await session.close();
});

// --- Resume, and Turns that can never run ----------------------------------

test("ClaudeEngine: open({ resume }) resumes that Conversation on the very first query", async () => {
  let capturedOptions: Options | undefined;
  const { query } = scriptedQuery([init("sdk-prev"), result()], {
    onOptions: (options) => {
      capturedOptions = options;
    },
  });
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({ projectDir: "/tmp/x", resume: "sdk-prev", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("hello again");
  const events = await collect(it, (e) => e.type === "turn_ended");

  assert.equal(capturedOptions?.resume, "sdk-prev");
  const conversation = events.find((e) => e.type === "conversation") as Extract<EngineEvent, { type: "conversation" }>;
  assert.deepEqual(conversation, { type: "conversation", id: "sdk-prev", resumed: true });
  await session.close();
});

test("ClaudeEngine: a Conversation id that changes mid-session is announced again, so it can be persisted", async () => {
  const query = reactiveQuery({
    subTurns: [
      [init("sdk-1"), assistantText("first"), result()],
      [init("sdk-2"), assistantText("second"), result()],
    ],
  });
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("first");
  const first = await collect(it, (e) => e.type === "turn_ended");
  session.send("second");
  const second = await collect(it, (e) => e.type === "turn_ended");

  const ids = [...first, ...second].filter((e) => e.type === "conversation").map((e) => (e as { id: string }).id);
  assert.deepEqual(ids, ["sdk-1", "sdk-2"]);
  await session.close();
});

test("ClaudeEngine: a Command pushed into a query that then dies still gets its Turn, ended as an error", async () => {
  let releaseDeath: () => void = () => undefined;
  const deathGate = new Promise<void>((resolve) => {
    releaseDeath = resolve;
  });
  const marker = { type: "rate_limit_event" } as unknown as Parameters<typeof scriptedQuery>[0][number];
  const { query } = scriptedQuery([init(), result(), marker], {
    onYield: async (message) => {
      if (message !== marker) return;
      await deathGate;
      throw new Error("subprocess exited");
    },
  });
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("first");
  await collect(it, (e) => e.type === "turn_ended");

  // The query is still open (a Background task could be keeping it alive), so
  // this is pushed into it -- and then the subprocess dies before reading it.
  session.send("second");
  releaseDeath();
  const events = await collect(it, (e) => e.type === "turn_ended");

  const started = events.filter((e) => e.type === "turn_started");
  assert.deepEqual(started, [{ type: "turn_started", cause: "command" }]);
  const ended = events.find((e) => e.type === "turn_ended") as Extract<EngineEvent, { type: "turn_ended" }>;
  assert.equal(ended.outcome, "error");
  assert.deepEqual(ended.errors, ["subprocess exited"]);
  await session.close();
});

test("ClaudeEngine: a query dying between Turns, with nothing queued, starts no Turn of its own", async () => {
  const marker = { type: "rate_limit_event" } as unknown as Parameters<typeof scriptedQuery>[0][number];
  const { query } = scriptedQuery([init(), result(), marker], {
    onYield: async (message) => {
      if (message === marker) throw new Error("subprocess exited");
    },
  });
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("first");
  await collect(it, (e) => e.type === "turn_ended");
  await new Promise((resolve) => setTimeout(resolve, 50));
  void session.close();

  const rest: EngineEvent[] = [];
  for (;;) {
    const next = await it.next();
    if (next.done) break;
    rest.push(next.value);
  }
  assert.deepEqual(rest, [], "the old Turn already reported its outcome; nothing was waiting on another");
});

test("ClaudeEngine: nothing the SDK yields after a Stop is reported, even if its generator keeps going", async () => {
  // Observed in production: a Stop mid-Turn can leave the SDK's generator
  // yielding further messages against an already-torn-down transport instead
  // of ending cleanly. Consuming them forever left the Turn never ending.
  let stop: () => void = () => undefined;
  const { query } = scriptedQuery(
    [init(), assistantText("before"), assistantText("should not appear"), result("error_during_execution")],
    {
      onYield: async (message) => {
        if (JSON.stringify(message).includes("should not appear")) stop();
      },
    },
  );
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  stop = () => session.stop();
  const it = session.events[Symbol.asyncIterator]();
  session.send("first");
  const events = await collect(it, (e) => e.type === "turn_ended");

  assert.ok(!events.some((e) => e.type === "assistant_text" && e.text === "should not appear"));
  assert.equal((events.at(-1) as Extract<EngineEvent, { type: "turn_ended" }>).outcome, "stopped");
  await session.close();
});

// --- The two Steer orderings the real SDK produces, beyond result-then-init --

function turnBoundaries(events: EngineEvent[]): string[] {
  return events
    .filter((e) => e.type === "turn_started" || e.type === "turn_ended")
    .map((e) => (e.type === "turn_started" ? `started:${e.cause}` : `ended:${e.outcome}`));
}

test("ClaudeEngine: a Steer confirmed by a fresh init before the truncated Turn reports anything still ends that Turn first", async () => {
  const query = reactiveQuery({
    subTurns: [
      [init(), assistantText("working")],
      [init("sdk-2"), assistantText("corrected"), result()],
    ],
  });
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("first");
  await collect(it, (e) => e.type === "turn_started");
  session.steer("a correction");
  const events = await collect(it, (e) => e.type === "turn_ended" && e.usage !== undefined);

  assert.deepEqual(turnBoundaries(events), ["ended:success", "started:steer", "ended:success"]);
  await session.close();
});

test("ClaudeEngine: a Local command Steered in and answered inside the running Turn still gets a Turn of its own", async () => {
  // The CLI answers a Local command itself: no fresh init ever confirms it,
  // just its own output inside whatever Turn is running. Without a Turn of
  // its own, whoever Steered it would wait on one forever.
  const localOutput = {
    type: "system",
    subtype: "local_command_output",
    content: "Compacted the conversation.",
  } as unknown as Parameters<typeof scriptedQuery>[0][number];
  const query = reactiveQuery({
    subTurns: [
      [init(), assistantText("working")],
      [localOutput, compactBoundary(), result()],
    ],
    hangAfterLast: true,
  });
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("first");
  await collect(it, (e) => e.type === "turn_started");
  session.steer("/compact");
  const events = await collect(it, (e) => e.type === "turn_ended" && e.usage !== undefined);

  assert.deepEqual(turnBoundaries(events), ["ended:success", "started:steer", "ended:success"]);
  assert.ok(
    events.findIndex((e) => e.type === "turn_started") < events.findIndex((e) => e.type === "status"),
    "the Local command's output belongs to the Steer's Turn",
  );
  await session.close();
});

test("ClaudeEngine: a Steer pending when the query ends cleanly still gets its Turn, ended without an error", async () => {
  const { query } = scriptedQuery([init(), assistantText("working"), result()], {
    onYield: async (message) => {
      if (message.type === "result") steerNow();
    },
  });
  let steerNow: () => void = () => undefined;
  const engine = new ClaudeEngine({ query, env: {} });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  steerNow = () => session.steer("a correction");
  const it = session.events[Symbol.asyncIterator]();
  session.send("first");
  let ended = 0;
  const events = await collect(it, (e) => e.type === "turn_ended" && ++ended === 2);

  assert.deepEqual(turnBoundaries(events), ["started:command", "ended:success", "started:steer", "ended:success"]);
  await session.close();
});

// --- The menu, and Fork's Conversation carry ---------------------------------

const probedMenu = {
  skills: [{ name: "probed-skill", description: "from the startup probe", argumentHint: "" }],
  localCommands: [{ name: "compact", description: "compact the conversation", argumentHint: "" }],
};

test("ClaudeEngine: the menu is published at open, before any Turn runs", async () => {
  const probedDirs: string[] = [];
  const engine = new ClaudeEngine({
    query: scriptedQuery([]).query,
    env: {},
    probeMenu: async (projectDir) => {
      probedDirs.push(projectDir);
      return probedMenu;
    },
  });
  const session = await engine.open({ projectDir: "/tmp/probe", onQuestion: noQuestionsExpected() });
  const [menu] = await collect(session.events[Symbol.asyncIterator](), (e) => e.type === "menu");

  assert.deepEqual(menu, { type: "menu", ...probedMenu });
  assert.deepEqual(probedDirs, ["/tmp/probe"]);
  await session.close();
});

test("ClaudeEngine: the menu is refreshed after a Turn's init, and a slower startup probe never overwrites it", async () => {
  let finishProbe: (menu: typeof probedMenu) => void = () => undefined;
  const { query } = scriptedQuery([initWithSkills(["fresh-skill"]), result()], {
    commands: [{ name: "fresh-skill", description: "installed (project)", argumentHint: "" }],
  });
  const engine = new ClaudeEngine({
    query,
    env: {},
    probeMenu: () => new Promise((resolve) => (finishProbe = resolve)),
  });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  const it = session.events[Symbol.asyncIterator]();
  session.send("hello");
  const [menu] = (await collect(it, (e) => e.type === "menu")).filter((e) => e.type === "menu");
  assert.deepEqual(menu, {
    type: "menu",
    skills: [{ name: "fresh-skill", description: "installed", argumentHint: "" }],
    localCommands: [],
  });

  finishProbe(probedMenu);
  await session.close();
  const rest: EngineEvent[] = [];
  for (let next = await it.next(); !next.done; next = await it.next()) rest.push(next.value);
  assert.ok(!rest.some((e) => e.type === "menu"), `a stale menu was published: ${JSON.stringify(rest)}`);
});

test("ClaudeEngine: a startup probe that fails leaves the menu for the first Turn to fill", async () => {
  const engine = new ClaudeEngine({
    query: scriptedQuery([]).query,
    env: {},
    probeMenu: async () => {
      throw new Error("no CLI");
    },
  });
  const session = await engine.open({ projectDir: "/tmp/x", onQuestion: noQuestionsExpected() });
  await session.close();
  const events: EngineEvent[] = [];
  for await (const e of session.events) events.push(e);
  assert.deepEqual(events, []);
});

test("ClaudeEngine: forkConversation copies the transcript to the new worktree, to resume there under the same id", async () => {
  const projectsDir = mkdtempSync(join(tmpdir(), "crc-claude-projects-"));
  const sourcePath = transcriptPath("/home/dev/repo", "conv-1", projectsDir);
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, '{"hello":"world"}\n');
  const engine = new ClaudeEngine({ query: scriptedQuery([]).query, env: {}, claudeProjectsDir: projectsDir });

  const resumeId = await engine.forkConversation({
    conversationId: "conv-1",
    fromDir: "/home/dev/repo",
    toDir: "/home/dev/repo.feature",
  });

  assert.equal(resumeId, "conv-1");
  assert.equal(
    readFileSync(join(projectsDir, "-home-dev-repo-feature", "conv-1.jsonl"), "utf-8"),
    '{"hello":"world"}\n',
  );
});

test("ClaudeEngine: forkConversation with no transcript to copy carries nothing", async () => {
  const projectsDir = mkdtempSync(join(tmpdir(), "crc-claude-projects-"));
  const engine = new ClaudeEngine({ query: scriptedQuery([]).query, env: {}, claudeProjectsDir: projectsDir });

  const resumeId = await engine.forkConversation({
    conversationId: "missing",
    fromDir: "/home/dev/repo",
    toDir: "/home/dev/repo.feature",
  });

  assert.equal(resumeId, undefined);
  assert.ok(!existsSync(join(projectsDir, "-home-dev-repo-feature")));
});

test("transcriptPath encodes the worktree path the way Claude Code files transcripts", () => {
  assert.equal(
    transcriptPath("/private/tmp/crc-encode-test.v1/sub.dir", "abc-123", "/projects"),
    "/projects/-private-tmp-crc-encode-test-v1-sub-dir/abc-123.jsonl",
  );
});
