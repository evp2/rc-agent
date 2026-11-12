import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { archivedText } from "../src/engine/archiveFileTool.ts";
import { forgetUnknownText, forgottenText, memoryFolderUnavailableText, memoryTooLargeText, rememberedText } from "../src/engine/memoryTools.ts";
import { createMemoryStore } from "../src/memory/store.ts";
import { memoryOptions } from "../src/session/memory.ts";
import type {
  ArchiveFileOutcome,
  Engine,
  EngineAnswer,
  EngineEvent,
  EngineFile,
  EngineForget,
  EngineImage,
  EngineMemory,
  EngineQuestion,
  ForgetOutcome,
  RememberOutcome,
  ShowImageOutcome,
} from "../src/engine/types.ts";
import { IMAGE_SHOWN } from "../src/engine/showImageTool.ts";

/** The `show_image` call every {@link EngineGuaranteeHarness.makeShowImageEngine} Turn makes. */
export const SHOW_IMAGE_CALL: EngineImage = {
  toolUseId: "show-image-1",
  path: "/tmp/shot.png",
  caption: "the login page",
};

/** The `archive_file` call every {@link EngineGuaranteeHarness.makeArchiveFileEngine} Turn makes. */
export const ARCHIVE_FILE_CALL: EngineFile = {
  toolUseId: "archive-file-1",
  path: "dist/app.exe",
};

/** The `remember` call every {@link EngineGuaranteeHarness.makeRememberEngine} Turn makes. */
export const REMEMBER_CALL: EngineMemory = {
  toolUseId: "remember-1",
  scope: "project",
  name: "commit-style",
  description: "How the person likes commits",
  content: "Short subjects.",
};

/** The `forget` call every {@link EngineGuaranteeHarness.makeForgetEngine} Turn makes. */
export const FORGET_CALL: EngineForget = {
  toolUseId: "forget-1",
  scope: "project",
  name: "commit-style",
};

/** The startup text every {@link EngineGuaranteeHarness.makeStartupTextEngine} session is opened with. */
export const STARTUP_TEXT = "Memories you can open:\n- commit-style: How the person likes commits";

/** What the SDK was handed back for a connector tool call, reduced to what every Engine's tool result carries. */
export interface ConnectorToolResult {
  text: string;
  isError: boolean;
}

/**
 * What a test harness supplies so the suite can drive each guarantee against
 * a real Engine instance, without knowing anything about which adapter it
 * is. Every factory returns a *fresh* Engine -- the suite opens and drives
 * each one itself.
 */
export interface EngineGuaranteeHarness {
  /** A Turn that finishes successfully on its own, with no interaction needed. */
  makeSimpleEngine(): Engine;
  /** A Turn that fails outright (a subprocess dying, a rejected promise, ...). */
  makeErroringEngine(): Engine;
  /** A Turn that never finishes on its own -- only `stop()` ends it. */
  makeHangingEngine(): Engine;
  /** A Turn that finishes on its own, followed by a second Turn that only begins once something is sent while the first has already ended. */
  makeQueueingEngine(): Engine;
  /** A Turn that hangs open until Steered, at which point a second (short, self-ending) Turn begins in its place. */
  makeSteerableEngine(): Engine;
  /** A Turn that starts one Background task (id `"bg-1"`) and then hangs open until `stop()` lands. */
  makeBackgroundTaskEngine?(): Engine;
  killsBackgroundTasks?: boolean;
  makeWakingBackgroundTaskEngine?(): Engine;
  /**
   * A Turn whose model calls `show_image` as {@link SHOW_IMAGE_CALL}, the
   * way the Engine's SDK really would, then finishes once the call has
   * returned. `toolResult()` is what the SDK got back from it, read once the
   * Turn has ended; undefined if the call never returned.
   */
  makeShowImageEngine?(): { engine: Engine; toolResult(): ConnectorToolResult | undefined };
  /** Like {@link makeShowImageEngine}, for an `archive_file` call as {@link ARCHIVE_FILE_CALL}. */
  makeArchiveFileEngine?(): { engine: Engine; toolResult(): ConnectorToolResult | undefined };
  /** Like {@link makeShowImageEngine}, for a `remember` call as {@link REMEMBER_CALL}. Absent for an Engine with its own memory. */
  makeRememberEngine?(): { engine: Engine; toolResult(): ConnectorToolResult | undefined };
  /** Like {@link makeShowImageEngine}, for a `forget` call as {@link FORGET_CALL}. */
  makeForgetEngine?(): { engine: Engine; toolResult(): ConnectorToolResult | undefined };
  /** A Turn that finishes on its own; `startupText()` is the memory text the Engine gave its model at the start of the Session, read once the Turn has ended. */
  makeStartupTextEngine?(): { engine: Engine; startupText(): string | undefined };
}

function openOptions(
  overrides: {
    resume?: string;
    projectDir?: string;
    startupText?: () => Promise<string | undefined>;
    onRemember?: (memory: EngineMemory, signal: AbortSignal) => Promise<RememberOutcome>;
    onForget?: (forget: EngineForget, signal: AbortSignal) => Promise<ForgetOutcome>;
    onShowImage?: (image: EngineImage, signal: AbortSignal) => Promise<ShowImageOutcome>;
    onArchiveFile?: (file: EngineFile, signal: AbortSignal) => Promise<ArchiveFileOutcome>;
  } = {},
): {
  projectDir: string;
  resume?: string;
  startupText?: () => Promise<string | undefined>;
  onRemember?: (memory: EngineMemory, signal: AbortSignal) => Promise<RememberOutcome>;
  onForget?: (forget: EngineForget, signal: AbortSignal) => Promise<ForgetOutcome>;
  onQuestion: (q: EngineQuestion, signal: AbortSignal) => Promise<EngineAnswer>;
  onShowImage?: (image: EngineImage, signal: AbortSignal) => Promise<ShowImageOutcome>;
  onArchiveFile?: (file: EngineFile, signal: AbortSignal) => Promise<ArchiveFileOutcome>;
} {
  return {
    projectDir: "/tmp/engine-guarantee-suite",
    ...overrides,
    onQuestion: () => new Promise<EngineAnswer>(() => undefined),
  };
}

const TIMED_OUT = Symbol("timed out");

/** Pulls from `iterator` until `predicate` matches an event, returning everything read (inclusive). Throws on timeout so a broken invariant fails fast rather than hanging the suite. */
async function readUntil(
  iterator: AsyncIterator<EngineEvent>,
  predicate: (e: EngineEvent) => boolean,
  timeoutMs = 2000,
): Promise<EngineEvent[]> {
  const collected: EngineEvent[] = [];
  for (;;) {
    const result = await Promise.race([
      iterator.next(),
      new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), timeoutMs)),
    ]);
    if (result === TIMED_OUT) {
      throw new Error(`timed out waiting for a matching event; collected so far: ${JSON.stringify(collected)}`);
    }
    if (result.done) throw new Error(`event stream ended before a matching event; collected: ${JSON.stringify(collected)}`);
    collected.push(result.value);
    if (predicate(result.value)) return collected;
  }
}

function turnStarted(e: EngineEvent): e is Extract<EngineEvent, { type: "turn_started" }> {
  return e.type === "turn_started";
}
function turnEnded(e: EngineEvent): e is Extract<EngineEvent, { type: "turn_ended" }> {
  return e.type === "turn_ended";
}

export function runEngineGuaranteeSuite(name: string, harness: EngineGuaranteeHarness): void {
  test(`${name}: an ordinary Turn starts and ends exactly once`, async () => {
    const session = await harness.makeSimpleEngine().open(openOptions());
    const it = session.events[Symbol.asyncIterator]();
    session.send("hello");
    const events = await readUntil(it, turnEnded);
    assert.equal(events.filter(turnStarted).length, 1);
    assert.equal(events.filter(turnEnded).length, 1);
    await session.close();
  });

  test(`${name}: a Turn that fails still ends exactly once`, async () => {
    const session = await harness.makeErroringEngine().open(openOptions());
    const it = session.events[Symbol.asyncIterator]();
    session.send("do something risky");
    const events = await readUntil(it, turnEnded);
    assert.equal(events.filter(turnStarted).length, 1);
    const ends = events.filter(turnEnded);
    assert.equal(ends.length, 1);
    assert.equal(ends[0].outcome, "error");
    await session.close();
  });

  test(`${name}: a Stopped Turn still ends exactly once`, async () => {
    const session = await harness.makeHangingEngine().open(openOptions());
    const it = session.events[Symbol.asyncIterator]();
    session.send("keep going");
    await readUntil(it, turnStarted);
    session.stop();
    const events = await readUntil(it, turnEnded);
    assert.equal(events.filter(turnStarted).length, 0, "no further Turn started while stopping this one");
    assert.equal(events.filter(turnEnded).length, 1);
    await session.close();
  });

  test(`${name}: Stop also ends a Command queued behind the stopped Turn, pairing its Turn as stopped`, async () => {
    const session = await harness.makeHangingEngine().open(openOptions());
    const it = session.events[Symbol.asyncIterator]();
    session.send("keep going");
    await readUntil(it, turnStarted);
    session.send("queued behind it");
    session.stop();
    let endedCount = 0;
    const events = await readUntil(it, (e) => {
      if (turnEnded(e)) endedCount += 1;
      return endedCount === 2;
    });
    const starts = events.filter(turnStarted);
    assert.equal(starts.length, 1, "the queued Command's Turn is reported, so whoever sent it hears how it ended");
    assert.equal(starts[0].cause, "command");
    assert.deepEqual(
      events.filter(turnEnded).map((e) => e.outcome),
      ["stopped", "stopped"],
    );
    await session.close();
  });

  test(`${name}: send() queues behind a running Turn and starts once it ends`, async () => {
    const session = await harness.makeQueueingEngine().open(openOptions());
    const it = session.events[Symbol.asyncIterator]();
    session.send("first");
    await readUntil(it, turnStarted);
    session.send("second");
    // The only way a second turn_started can arrive is after the first's
    // turn_ended -- if the fake or the adapter ever let it jump the queue,
    // this assertion (not a timeout) is what would catch it. Collected
    // rather than assumed adjacent, since a real Turn's own content
    // (assistant text, tool calls) sits between the two.
    const rest = await readUntil(it, turnStarted);
    assert.equal(rest.filter(turnStarted).length, 1, "no Turn started for the queued Command early");
    assert.equal(rest.filter(turnEnded).length, 1, "the first Turn's own outcome came before the second ever started");
    assert.equal((rest.find(turnStarted) as Extract<EngineEvent, { type: "turn_started" }>).cause, "command");
    await session.close();
  });

  test(`${name}: a delivered Steer ends the Turn, then starts a fresh one with cause "steer"`, async () => {
    const engine = harness.makeSteerableEngine();
    const session = await engine.open(openOptions());
    if (!engine.capabilities.steer) {
      await session.close();
      return;
    }
    const it = session.events[Symbol.asyncIterator]();
    session.send("first");
    await readUntil(it, turnStarted);
    session.steer("a correction");
    let endedCount = 0;
    const events = await readUntil(it, (e) => {
      if (turnEnded(e)) endedCount += 1;
      return endedCount === 2;
    });
    const firstEndIndex = events.findIndex(turnEnded);
    const next = events[firstEndIndex + 1];
    assert.ok(next && turnStarted(next), "turn_started followed turn_ended immediately");
    assert.equal((next as Extract<EngineEvent, { type: "turn_started" }>).cause, "steer");
    await session.close();
  });

  test(`${name}: Stop ends every running Background task`, { skip: !harness.makeBackgroundTaskEngine }, async () => {
    const session = await harness.makeBackgroundTaskEngine!().open(openOptions());
    const it = session.events[Symbol.asyncIterator]();
    session.send("kick off a background task");
    await readUntil(it, (e) => e.type === "task_started");
    session.stop();
    const events = await readUntil(it, turnEnded);
    const settled = events.find((e) => e.type === "task_settled");
    assert.ok(settled, "the Background task was reported settled once Stop landed");
    assert.equal((settled as Extract<EngineEvent, { type: "task_settled" }>).status, "stopped");
    await session.close();
  });

  test(`${name}: Kill ends one Background task and the Turn keeps running`, { skip: !harness.killsBackgroundTasks }, async () => {
    const session = await harness.makeBackgroundTaskEngine!().open(openOptions());
    const it = session.events[Symbol.asyncIterator]();
    session.send("kick off a background task");
    const [started] = (await readUntil(it, (e) => e.type === "task_started")).slice(-1) as [
      Extract<EngineEvent, { type: "task_started" }>,
    ];
    await session.killTask(started.taskId);
    const killed = await readUntil(it, (e) => e.type === "task_settled");
    const settled = killed.at(-1) as Extract<EngineEvent, { type: "task_settled" }>;
    assert.equal(settled.taskId, started.taskId);
    assert.equal(settled.status, "stopped");
    assert.equal(killed.some(turnEnded), false, "the Turn was still running when the task settled");
    session.stop();
    const rest = await readUntil(it, turnEnded);
    assert.equal(rest.filter((e) => e.type === "task_settled").length, 0, "the task settled once only");
    assert.equal(rest.filter(turnEnded)[0].outcome, "stopped", "the Turn had been running until Stop");
    await session.close();
  });

  test(`${name}: Kill of an unknown or already settled task id does nothing`, { skip: !harness.killsBackgroundTasks }, async () => {
    const session = await harness.makeBackgroundTaskEngine!().open(openOptions());
    const it = session.events[Symbol.asyncIterator]();
    session.send("kick off a background task");
    const started = (await readUntil(it, (e) => e.type === "task_started")).at(-1) as Extract<
      EngineEvent,
      { type: "task_started" }
    >;
    await session.killTask("no-such-task");
    await session.killTask(started.taskId);
    await readUntil(it, (e) => e.type === "task_settled");
    await session.killTask(started.taskId);
    session.stop();
    const rest = await readUntil(it, turnEnded);
    assert.equal(rest.filter((e) => e.type === "task_settled").length, 0, "nothing settled a second time");
    assert.equal(rest.filter(turnEnded)[0].outcome, "stopped");
    await session.close();
  });

  test(`${name}: Stop settles every live Background task stopped before the Turn's end, once`, { skip: !harness.killsBackgroundTasks }, async () => {
    const session = await harness.makeBackgroundTaskEngine!().open(openOptions());
    const it = session.events[Symbol.asyncIterator]();
    session.send("kick off a background task");
    await readUntil(it, (e) => e.type === "task_started");
    session.stop();
    const events = await readUntil(it, turnEnded);
    const settles = events.filter((e) => e.type === "task_settled");
    assert.equal(settles.length, 1);
    assert.equal((settles[0] as Extract<EngineEvent, { type: "task_settled" }>).status, "stopped");
    assert.ok(events.indexOf(settles[0]) < events.findIndex(turnEnded), "settled before the Turn's end");
    await session.close();
  });

  test(`${name}: a Background task finishing after the Turn opens a Turn caused by the Engine, paired start to end`, { skip: !harness.makeWakingBackgroundTaskEngine }, async () => {
    const session = await harness.makeWakingBackgroundTaskEngine!().open(openOptions());
    const it = session.events[Symbol.asyncIterator]();
    session.send("start something and finish");
    const first = await readUntil(it, turnEnded);
    assert.equal(first.filter(turnStarted).length, 1);
    const woken = await readUntil(it, turnEnded);
    const starts = woken.filter(turnStarted);
    assert.equal(starts.length, 1, "exactly one Turn started by itself");
    assert.equal(starts[0].cause, "engine");
    assert.equal(woken.filter(turnEnded).length, 1);
    assert.ok(woken.findIndex(turnStarted) < woken.findIndex(turnEnded));
    await session.close();
  });

  for (const outcome of [{ shown: true }, { shown: false, reason: "not a PNG" }] satisfies ShowImageOutcome[]) {
    const kind = outcome.shown ? "success" : "failure";
    test(`${name}: a show_image call reaches onShowImage, and its ${kind} comes back as the tool result`, { skip: !harness.makeShowImageEngine }, async () => {
      const { engine, toolResult } = harness.makeShowImageEngine!();
      const received: EngineImage[] = [];
      const session = await engine.open(
        openOptions({
          onShowImage: async (image) => {
            received.push(image);
            return outcome;
          },
        }),
      );
      const it = session.events[Symbol.asyncIterator]();
      session.send("show me");
      await readUntil(it, turnEnded);
      assert.deepEqual(received, [SHOW_IMAGE_CALL]);
      const result = toolResult();
      assert.ok(result, "the call returned a tool result to the SDK");
      assert.equal(result.isError, !outcome.shown);
      if (outcome.shown) assert.equal(result.text, IMAGE_SHOWN, "the success is the shared confirmation");
      else assert.equal(result.text, outcome.reason, "the failure carries the reason");
      await session.close();
    });
  }

  for (const outcome of [
    { archived: true, filename: "app.exe", byteLength: 2048 },
    { archived: false, reason: "no file there" },
  ] satisfies ArchiveFileOutcome[]) {
    const kind = outcome.archived ? "success" : "failure";
    test(`${name}: an archive_file call reaches onArchiveFile, and its ${kind} comes back as the tool result`, { skip: !harness.makeArchiveFileEngine }, async () => {
      const { engine, toolResult } = harness.makeArchiveFileEngine!();
      const received: EngineFile[] = [];
      const session = await engine.open(
        openOptions({
          onArchiveFile: async (file) => {
            received.push(file);
            return outcome;
          },
        }),
      );
      const it = session.events[Symbol.asyncIterator]();
      session.send("archive it");
      await readUntil(it, turnEnded);
      assert.deepEqual(received, [ARCHIVE_FILE_CALL]);
      const result = toolResult();
      assert.ok(result, "the call returned a tool result to the SDK");
      assert.equal(result.isError, !outcome.archived);
      if (outcome.archived) {
        assert.equal(result.text, archivedText(outcome.filename, outcome.byteLength), "the success is the shared confirmation");
      } else assert.equal(result.text, outcome.reason, "the failure carries the reason");
      await session.close();
    });
  }

  for (const outcome of [
    { saved: true, index: "- commit-style: How the person likes commits" },
    { saved: true, index: "- commit-style: How the person likes commits", replaced: true },
    { saved: false, reason: "that looks like a credential" },
  ] satisfies RememberOutcome[]) {
    const kind = !outcome.saved ? "failure" : outcome.replaced ? "replacement success" : "success";
    test(`${name}: a remember call reaches onRemember, and its ${kind} comes back as the tool result`, { skip: !harness.makeRememberEngine }, async () => {
      const { engine, toolResult } = harness.makeRememberEngine!();
      const received: EngineMemory[] = [];
      const session = await engine.open(
        openOptions({
          onRemember: async (memory) => {
            received.push(memory);
            return outcome;
          },
        }),
      );
      const it = session.events[Symbol.asyncIterator]();
      session.send("remember it");
      await readUntil(it, turnEnded);
      assert.deepEqual(received, [REMEMBER_CALL]);
      const result = toolResult();
      assert.ok(result, "the call returned a tool result to the SDK");
      assert.equal(result.isError, !outcome.saved);
      if (outcome.saved) {
        assert.equal(result.text, rememberedText(REMEMBER_CALL.scope, outcome.index, outcome.replaced), "the success carries the updated index");
      } else assert.equal(result.text, outcome.reason, "the failure carries the reason");
      await session.close();
    });
  }

  test(`${name}: a remember call the store refuses comes back as the shared refusal and writes nothing`, { skip: !harness.makeRememberEngine }, async () => {
    const root = mkdtempSync(join(tmpdir(), "guarantee-memory-"));
    try {
      const store = createMemoryStore(root, { maxIndexLines: 200, maxMemoryBytes: 5 });
      const { engine, toolResult } = harness.makeRememberEngine!();
      const session = await engine.open(
        openOptions({ onRemember: ({ name, description, content }) => store.save("global", { name, description, body: content }) }),
      );
      const it = session.events[Symbol.asyncIterator]();
      session.send("remember it");
      await readUntil(it, turnEnded);
      const result = toolResult();
      assert.ok(result, "the call returned a tool result to the SDK");
      assert.equal(result.isError, true);
      assert.equal(result.text, memoryTooLargeText(5));
      assert.equal(existsSync(join(root, "global")), false);
      await session.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const BROKEN_FOLDERS: Record<string, (parent: string) => { root: string; restore?: () => void }> = {
    missing: (parent) => ({ root: join(parent, "never-created") }),
    "in a file's place": (parent) => {
      const root = join(parent, "a-file");
      writeFileSync(root, "not a folder");
      return { root };
    },
    unreadable: (parent) => {
      const root = join(parent, "memories");
      mkdirSync(join(root, "global"), { recursive: true });
      chmodSync(join(root, "global"), 0o000);
      return { root, restore: () => chmodSync(join(root, "global"), 0o700) };
    },
  };

  for (const [problem, breakIt] of Object.entries(BROKEN_FOLDERS)) {
    test(`${name}: a Session starts and answers with the memory folder ${problem}, with no Memories`, { skip: !harness.makeStartupTextEngine }, async () => {
      const parent = mkdtempSync(join(tmpdir(), "guarantee-broken-memory-"));
      const { root, restore } = breakIt(parent);
      try {
        const { engine, startupText } = harness.makeStartupTextEngine!();
        const session = await engine.open(openOptions(memoryOptions(parent, root)));
        const it = session.events[Symbol.asyncIterator]();
        session.send("hello");
        await readUntil(it, turnEnded);
        assert.ok(!/Global memories:\n-/.test(startupText() ?? ""), "no Memories were listed");
        assert.doesNotMatch(startupText() ?? "", /EACCES|ENOENT|ENOTDIR/, "no raw error reached the model");
        await session.close();
      } finally {
        restore?.();
        rmSync(parent, { recursive: true, force: true });
      }
    });
  }

  test(`${name}: a remember call into a folder that is not writable fails plainly, writes nothing, and is not reported as saved`, { skip: !harness.makeRememberEngine }, async () => {
    const parent = mkdtempSync(join(tmpdir(), "guarantee-readonly-memory-"));
    const root = join(parent, "memories");
    mkdirSync(root);
    chmodSync(root, 0o500);
    try {
      const { engine, toolResult } = harness.makeRememberEngine!();
      const session = await engine.open(openOptions(memoryOptions(parent, root)));
      const it = session.events[Symbol.asyncIterator]();
      session.send("remember it");
      await readUntil(it, turnEnded);
      const result = toolResult();
      assert.ok(result, "the call returned a tool result to the SDK");
      assert.equal(result.isError, true);
      assert.equal(result.text, memoryFolderUnavailableText());
      assert.equal(existsSync(join(root, "global")), false);
      await session.close();
    } finally {
      chmodSync(root, 0o700);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  for (const outcome of [
    { forgotten: true, index: "- tabs: Tabs please" },
    { forgotten: false, reason: "no such memory" },
  ] satisfies ForgetOutcome[]) {
    const kind = outcome.forgotten ? "success" : "failure";
    test(`${name}: a forget call reaches onForget, and its ${kind} comes back as the tool result`, { skip: !harness.makeForgetEngine }, async () => {
      const { engine, toolResult } = harness.makeForgetEngine!();
      const received: EngineForget[] = [];
      const session = await engine.open(
        openOptions({
          onForget: async (forget) => {
            received.push(forget);
            return outcome;
          },
        }),
      );
      const it = session.events[Symbol.asyncIterator]();
      session.send("forget it");
      await readUntil(it, turnEnded);
      assert.deepEqual(received, [FORGET_CALL]);
      const result = toolResult();
      assert.ok(result, "the call returned a tool result to the SDK");
      assert.equal(result.isError, !outcome.forgotten);
      if (outcome.forgotten) {
        assert.equal(result.text, forgottenText(FORGET_CALL.scope, outcome.index), "the success carries the updated index");
      } else assert.equal(result.text, outcome.reason, "the failure carries the reason");
      await session.close();
    });
  }

  test(`${name}: a forget call against the store drops a Project memory from its index and keeps its file aside`, { skip: !harness.makeForgetEngine }, async () => {
    const base = mkdtempSync(join(tmpdir(), "guarantee-forget-project-"));
    try {
      const root = join(base, "memories");
      const repo = join(base, "repo");
      mkdirSync(repo);
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: repo });
      const options = memoryOptions(repo, root);
      const signal = new AbortController().signal;
      const save = (scope: "global" | "project", name: string) =>
        options.onRemember!({ toolUseId: "s", scope, name, description: "How the person likes commits", content: "Short subjects." }, signal);
      await save("project", FORGET_CALL.name);
      await save("global", "editor");
      await save("global", FORGET_CALL.name);
      const { engine, toolResult } = harness.makeForgetEngine!();
      const session = await engine.open(openOptions({ projectDir: repo, ...options }));
      const it = session.events[Symbol.asyncIterator]();
      session.send("forget it");
      await readUntil(it, turnEnded);
      assert.equal(toolResult()?.text, forgottenText("project", ""));
      const [key] = readdirSync(join(root, "projects"));
      assert.deepEqual(readdirSync(join(root, "projects", key!)), ["MEMORY.md"]);
      assert.equal(readFileSync(join(root, "projects", key!, "MEMORY.md"), "utf-8").trim(), "");
      assert.equal(readdirSync(join(root, "forgotten", "projects", key!)).length, 1);
      assert.equal(readFileSync(join(root, "global", "MEMORY.md"), "utf-8").split("\n").filter(Boolean).length, 2, "the Global memories are untouched");
      await session.close();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test(`${name}: a forget call for a name that exists only in the other scope changes nothing`, { skip: !harness.makeForgetEngine }, async () => {
    const root = mkdtempSync(join(tmpdir(), "guarantee-forget-scope-"));
    try {
      const options = memoryOptions(root, join(root, "memories"));
      await options.onRemember!(
        { toolUseId: "s", scope: "global", name: FORGET_CALL.name, description: "How the person likes commits", content: "Short subjects." },
        new AbortController().signal,
      );
      const { engine, toolResult } = harness.makeForgetEngine!();
      const session = await engine.open(openOptions({ projectDir: root, ...options }));
      const it = session.events[Symbol.asyncIterator]();
      session.send("forget it");
      await readUntil(it, turnEnded);
      assert.equal(toolResult()?.isError, true);
      assert.equal(toolResult()?.text, forgetUnknownText(FORGET_CALL.name));
      assert.equal(existsSync(join(root, "memories", "forgotten")), false);
      assert.ok(existsSync(join(root, "memories", "global", `${FORGET_CALL.name}.md`)));
      await session.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${name}: a forget call against an unreadable memory folder fails plainly, changes nothing, and is not reported as forgotten`, { skip: !harness.makeForgetEngine }, async () => {
    const base = mkdtempSync(join(tmpdir(), "guarantee-forget-broken-"));
    const root = join(base, "memories");
    const repo = join(base, "repo");
    mkdirSync(repo);
    try {
      const options = memoryOptions(repo, root);
      await options.onRemember!(
        { toolUseId: "s", scope: "project", name: FORGET_CALL.name, description: "How the person likes commits", content: "Short subjects." },
        new AbortController().signal,
      );
      const projects = join(root, "projects");
      const folder = join(projects, readdirSync(projects)[0]!);
      chmodSync(folder, 0o000);
      try {
        const { engine, toolResult } = harness.makeForgetEngine!();
        const session = await engine.open(openOptions({ projectDir: repo, ...options }));
        const it = session.events[Symbol.asyncIterator]();
        session.send("forget it");
        await readUntil(it, turnEnded);
        const result = toolResult();
        assert.ok(result, "the call returned a tool result to the SDK");
        assert.equal(result.isError, true);
        assert.equal(result.text, memoryFolderUnavailableText());
        await session.close();
      } finally {
        chmodSync(folder, 0o700);
      }
      assert.deepEqual(readdirSync(folder).sort(), ["MEMORY.md", `${FORGET_CALL.name}.md`]);
      assert.equal(existsSync(join(root, "forgotten")), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test(`${name}: the memory text is given to the model at the start of a Session`, { skip: !harness.makeStartupTextEngine }, async () => {
    const { engine, startupText } = harness.makeStartupTextEngine!();
    const session = await engine.open(openOptions({ startupText: async () => STARTUP_TEXT }));
    const it = session.events[Symbol.asyncIterator]();
    session.send("hello");
    await readUntil(it, turnEnded);
    assert.ok(startupText()?.includes(STARTUP_TEXT), "the Engine's model was given the memory text");
    await session.close();
  });

  test(
    `${name}: a Project memory is told to Sessions in any worktree of its repository, beside the Global ones, and to no other repository`,
    { skip: !harness.makeRememberEngine || !harness.makeStartupTextEngine },
    async () => {
      const base = mkdtempSync(join(tmpdir(), "guarantee-project-memory-"));
      try {
        const memories = join(base, "memories");
        const repo = join(base, "repo");
        const worktree = join(base, "repo-linked");
        const elsewhere = join(base, "elsewhere");
        for (const dir of [repo, elsewhere]) {
          mkdirSync(dir);
          execFileSync("git", ["init", "-q"], { cwd: dir });
          execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: dir });
        }
        execFileSync("git", ["worktree", "add", "-q", worktree, "-b", "other"], { cwd: repo });
        await memoryOptions(repo, memories).onRemember!(
          { toolUseId: "g", scope: "global", name: "editor", description: "Preferred editor", content: "vim" },
          new AbortController().signal,
        );

        const { engine, toolResult } = harness.makeRememberEngine!();
        const saving = await engine.open(openOptions({ projectDir: repo, ...memoryOptions(repo, memories) }));
        const savingEvents = saving.events[Symbol.asyncIterator]();
        saving.send("remember it");
        await readUntil(savingEvents, turnEnded);
        assert.ok(toolResult()?.text.includes("Project memories are now"), "the reply names the scope it saved into");
        await saving.close();

        const told = async (dir: string): Promise<string> => {
          const { engine: next, startupText } = harness.makeStartupTextEngine!();
          const session = await next.open(openOptions({ projectDir: dir, ...memoryOptions(dir, memories) }));
          const events = session.events[Symbol.asyncIterator]();
          session.send("hello");
          await readUntil(events, turnEnded);
          await session.close();
          return startupText() ?? "";
        };
        for (const dir of [repo, worktree]) {
          const text = await told(dir);
          assert.match(text, /commit-style: How the person likes commits/);
          assert.match(text, /editor: Preferred editor/);
        }
        const other = await told(elsewhere);
        assert.doesNotMatch(other, /commit-style: How the person likes commits/);
        assert.match(other, /editor: Preferred editor/);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  for (const [broken, kept, keptPattern] of [
    ["project", "global", /editor: Preferred editor/],
    ["global", "project", /commit-style: How the person likes commits/],
  ] as const) {
    test(
      `${name}: an unreadable ${broken} memory folder still leaves the ${kept} memories in the startup text`,
      { skip: !harness.makeStartupTextEngine },
      async () => {
        const base = mkdtempSync(join(tmpdir(), "guarantee-one-scope-broken-"));
        const root = join(base, "memories");
        const repo = join(base, "repo");
        mkdirSync(repo);
        let restore: (() => void) | undefined;
        try {
          const options = memoryOptions(repo, root);
          const signal = new AbortController().signal;
          await options.onRemember!({ toolUseId: "g", scope: "global", name: "editor", description: "Preferred editor", content: "vim" }, signal);
          await options.onRemember!({ toolUseId: "p", scope: "project", name: "commit-style", description: "How the person likes commits", content: "Short." }, signal);
          const projects = join(root, "projects");
          const folder = broken === "global" ? join(root, "global") : join(projects, readdirSync(projects)[0]!);
          chmodSync(folder, 0o000);
          restore = () => chmodSync(folder, 0o700);
          const { engine, startupText } = harness.makeStartupTextEngine!();
          const session = await engine.open(openOptions({ projectDir: repo, ...options }));
          const events = session.events[Symbol.asyncIterator]();
          session.send("hello");
          await readUntil(events, turnEnded);
          await session.close();
          assert.match(startupText() ?? "", keptPattern);
        } finally {
          restore?.();
          rmSync(base, { recursive: true, force: true });
        }
      },
    );
  }

  test(`${name}: a missing Conversation opens fresh and is reported as lost`, async () => {
    const session = await harness.makeSimpleEngine().open(openOptions({ resume: "a-conversation-that-does-not-exist" }));
    const it = session.events[Symbol.asyncIterator]();
    // Some adapters only learn the Conversation id once a Turn actually
    // starts (Claude's is the first `system:init`), so this must drive one
    // rather than assume `conversation` is announced at open() time.
    session.send("hello");
    const events = await readUntil(it, (e) => e.type === "conversation");
    const conversation = events.find((e) => e.type === "conversation") as Extract<
      EngineEvent,
      { type: "conversation" }
    >;
    assert.equal(conversation.resumed, false);
    assert.equal(conversation.lostPrevious, true);
    await session.close();
  });
}
