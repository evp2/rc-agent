import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";

import type { EngineAnswer, EngineEvent } from "../src/engine/types.ts";
import { answeringByPrompt, callingTools, piEngineOn, startingShell, untilAborted, writePiSettings } from "./piDoubles.ts";

after(() => writePiSettings({}));

type Event<T extends EngineEvent["type"]> = Extract<EngineEvent, { type: T }>;

function openOptions(projectDir: string) {
  return { projectDir, onQuestion: () => new Promise<EngineAnswer>(() => undefined) };
}

async function readUntil(
  it: AsyncIterator<EngineEvent>,
  predicate: (e: EngineEvent) => boolean,
  timeoutMs = 8000,
): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out; read ${JSON.stringify(events)}`)), timeoutMs);
  });
  try {
    for (;;) {
      const next = await Promise.race([it.next(), timeout]);
      if (next.done) throw new Error(`event stream ended; read ${JSON.stringify(events)}`);
      events.push(next.value);
      if (predicate(next.value)) return events;
    }
  } finally {
    clearTimeout(timer);
  }
}

const isTurnEnd = (e: EngineEvent) => e.type === "turn_ended";
const isSettled = (e: EngineEvent) => e.type === "task_settled";

async function openSession(responses: FauxResponseStep[]) {
  const pi = piEngineOn(responses);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  return { session, it: session.events[Symbol.asyncIterator](), pi };
}

function only<T extends EngineEvent["type"]>(events: EngineEvent[], type: T): Event<T> {
  const found = events.filter((e): e is Event<T> => e.type === type);
  assert.equal(found.length, 1, `exactly one ${type} in ${JSON.stringify(events)}`);
  return found[0];
}

test("PiEngine: bash_background returns a task id at once, and the task settles completed with its exit status and last output", async () => {
  const { session, it } = await openSession([
    startingShell("echo hello; sleep 0.2; echo goodbye", "call-bg", "say hello"),
    fauxAssistantMessage("started it"),
    fauxAssistantMessage("it finished"),
  ]);
  session.send("run it in the background");
  const first = await readUntil(it, isTurnEnd);
  const started = only(first, "task_started");
  assert.deepEqual(started, {
    type: "task_started",
    taskId: started.taskId,
    toolUseId: "call-bg",
    description: "say hello",
    taskType: "shell",
    ambient: false,
  });
  const result = only(first, "tool_result");
  assert.ok(result.text?.includes(started.taskId), `the tool result names the task id: ${result.text}`);
  assert.equal(first.some(isSettled), false, "the Turn ended while the command still ran");
  assert.deepEqual(first.filter((e) => e.type === "tasks_changed").at(-1), {
    type: "tasks_changed",
    tasks: [{ taskId: started.taskId, taskType: "shell", description: "say hello" }],
  });

  const later = await readUntil(it, (e) => e.type === "tasks_changed" && e.tasks.length === 0);
  const settled = only(later, "task_settled");
  assert.equal(settled.taskId, started.taskId);
  assert.equal(settled.status, "completed");
  assert.match(settled.summary ?? "", /exit(ed)? (with )?(code |status )?0/);
  assert.match(settled.summary ?? "", /goodbye/);
  assert.equal(settled.ambient, false);
  await session.close();
});

test("PiEngine: a command that exits non-zero settles failed", async () => {
  const { session, it } = await openSession([
    startingShell("echo boom >&2; exit 3"),
    fauxAssistantMessage("started it"),
    fauxAssistantMessage("it failed"),
  ]);
  session.send("go");
  const events = await readUntil(it, isSettled);
  const settled = only(events, "task_settled");
  assert.equal(settled.status, "failed");
  assert.match(settled.summary ?? "", /3/);
  assert.match(settled.summary ?? "", /boom/);
  await session.close();
});

function text(context: { messages: { role: string; content: unknown }[] }): string {
  return JSON.stringify(context.messages.map((m) => m.content));
}

test("PiEngine: a task finishing while idle is news to the phone before the Engine's own Turn, and the model is handed its result", async () => {
  let seen = "";
  const { session, it } = await openSession([
    startingShell("echo build ok", "call-bg", "build"),
    fauxAssistantMessage("started it"),
    (context) => {
      seen = text(context);
      return fauxAssistantMessage("the build passed");
    },
  ]);
  session.send("build it");
  await readUntil(it, isTurnEnd);
  const events = await readUntil(it, isTurnEnd);
  const types = events.map((e) => e.type);
  assert.ok(types.indexOf("task_settled") < types.indexOf("turn_started"), "the settle came with no Turn open");
  assert.equal(only(events, "turn_started").cause, "engine");
  assert.deepEqual(events.filter((e) => e.type === "assistant_text"), [{ type: "assistant_text", text: "the build passed" }]);
  assert.match(seen, /build ok/);
  assert.match(seen, /completed/);
  await session.close();
});

test("PiEngine: a task finishing during a streaming Turn is delivered to that Turn, not a new one", async () => {
  let seen = "";
  const { session, it } = await openSession([
    startingShell("echo early"),
    async () => {
      await new Promise((r) => setTimeout(r, 600));
      return fauxAssistantMessage("still working");
    },
    (context) => {
      seen = text(context);
      return fauxAssistantMessage("saw it");
    },
  ]);
  session.send("go");
  const events = await readUntil(it, isTurnEnd);
  assert.equal(events.filter((e) => e.type === "turn_started").length, 1);
  assert.ok(events.some(isSettled), "the task settled while the Turn was open");
  assert.match(seen, /early/);
  assert.deepEqual(
    events.filter((e) => e.type === "assistant_text").map((e) => (e as Event<"assistant_text">).text),
    ["still working", "saw it"],
  );
  await session.close();
});

test("PiEngine: a task Stop ended does not wake the model", async () => {
  const { session, it, pi } = await openSession([startingShell("sleep 30"), untilAborted, fauxAssistantMessage("woken")]);
  session.send("go");
  await readUntil(it, (e) => e.type === "task_started");
  session.stop();
  await readUntil(it, isTurnEnd);
  const pending = pi.faux.getPendingResponseCount();
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(pi.faux.getPendingResponseCount(), pending, "no model call was made after Stop");
  await session.close();
});

test("PiEngine: Kill between Turns settles the shell task stopped without waking the model, and the next Turn sees the note", async () => {
  let seen = "";
  const { session, it, pi } = await openSession([
    startingShell("sleep 30", "call-bg", "long build"),
    fauxAssistantMessage("started it"),
    (context) => {
      seen = text(context);
      return fauxAssistantMessage("noted");
    },
  ]);
  session.send("go");
  const first = await readUntil(it, isTurnEnd);
  const { taskId } = only(first, "task_started");
  await session.killTask(taskId);
  const settledEvents = await readUntil(it, (e) => e.type === "tasks_changed" && e.tasks.length === 0);
  assert.equal(only(settledEvents, "task_settled").status, "stopped");
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(pi.faux.getPendingResponseCount(), 1, "no model call was made after Kill");
  assert.equal(seen, "", "the model has not been called since the task was killed");

  session.send("what happened to it?");
  const second = await readUntil(it, isTurnEnd);
  assert.equal(only(second, "turn_started").cause, "command");
  assert.match(seen, new RegExp(`${taskId}.*long build.*stopped`));
  await session.close();
});

test("PiEngine: Kill of a shell task during a streaming Turn adds no follow-up for it", async () => {
  const { session, it, pi } = await openSession([
    startingShell("sleep 30"),
    async () => {
      await new Promise((r) => setTimeout(r, 800));
      return fauxAssistantMessage("still working");
    },
    fauxAssistantMessage("a follow-up that must not run"),
  ]);
  session.send("go");
  const head = await readUntil(it, (e) => e.type === "task_started");
  await session.killTask(only(head, "task_started").taskId);
  const events = await readUntil(it, isTurnEnd);
  assert.equal(only(events, "task_settled").status, "stopped");
  assert.deepEqual(events.filter((e) => e.type === "assistant_text"), [{ type: "assistant_text", text: "still working" }]);
  assert.equal(pi.faux.getPendingResponseCount(), 1, "the Turn made no further model call for the Kill");
  await session.close();
});

test("PiEngine: no more than four tasks run at once, and the fifth call is told so", async () => {
  const calls = [1, 2, 3, 4, 5].map((n) => ({ name: "bash_background", args: { command: "sleep 30" }, id: `call-${n}` }));
  const model = callingTools(calls);
  const { session, it } = await openSession(model.steps);
  session.send("start five");
  const events = await readUntil(it, isTurnEnd);
  assert.equal(events.filter((e) => e.type === "task_started").length, 4);
  const results = [...model.results().values()];
  assert.equal(results.filter((r) => r.isError).length, 1);
  assert.match(results.find((r) => r.isError)!.text, /4 background tasks/);
  session.stop();
  await session.close();
});

test("PiEngine: a wake due during a manual /compact waits until the compaction is over", async () => {
  writePiSettings({ compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 300 } });
  const later = answeringByPrompt((prompt) =>
    prompt.includes("checkpoint")
      ? async () => {
          await new Promise((r) => setTimeout(r, 1200));
          return fauxAssistantMessage("## Goal\nsaid a lot");
        }
      : fauxAssistantMessage("the wake reply"),
  );
  const { session, it } = await openSession([
    startingShell("sleep 0.6"),
    fauxAssistantMessage("started it"),
    fauxAssistantMessage("word ".repeat(3_000)),
    ...later.steps,
  ]);
  session.send("go");
  await readUntil(it, isTurnEnd);
  session.send("say a lot");
  await readUntil(it, isTurnEnd);
  session.send("/compact");
  const compaction = await readUntil(it, isTurnEnd);
  const types = compaction.map((e) => e.type);
  assert.equal(only(compaction, "turn_started").cause, "command");
  assert.ok(types.indexOf("compacted") >= 0 && types.indexOf("compacted") < types.indexOf("turn_ended"), JSON.stringify(compaction));
  assert.ok(compaction.some(isSettled), "the task settled while the compaction ran");
  assert.equal(types.includes("assistant_text"), false, "no wake run executed inside the compaction");
  const wake = await readUntil(it, isTurnEnd);
  assert.equal(only(wake, "turn_started").cause, "engine");
  assert.deepEqual(wake.filter((e) => e.type === "assistant_text"), [{ type: "assistant_text", text: "the wake reply" }]);
  await session.close();
});

test("PiEngine: Kill just after the command exited reports its own outcome, not stopped", { skip: process.platform === "win32" }, async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "pi-task-")), "exiting");
  const { session, it } = await openSession([
    startingShell(`sleep 2 & echo x > ${marker}; exit 3`),
    fauxAssistantMessage("started it"),
    fauxAssistantMessage("noted"),
  ]);
  session.send("go");
  const head = await readUntil(it, (e) => e.type === "task_started");
  await eventually(() => (existsSync(marker) ? true : undefined), "the command to be on its way out", 8000, 5);
  await new Promise((r) => setTimeout(r, 60));
  await session.killTask(only(head, "task_started").taskId);
  const events = await readUntil(it, isSettled);
  const settled = only(events, "task_settled");
  assert.equal(settled.status, "failed");
  assert.match(settled.summary ?? "", /3/);
  await session.close();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually<T>(read: () => T | undefined, what: string, timeoutMs = 8000, pollMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function recordedPid(file: string): number | undefined {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    return pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

test("PiEngine: closing the session ends the command and reports no settle", { skip: process.platform === "win32" }, async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "pi-task-")), "pid");
  const { session, it } = await openSession([startingShell(`echo $$ > ${pidFile}; exec sleep 60`), untilAborted]);
  session.send("go");
  await readUntil(it, (e) => e.type === "task_started");
  const pid = await eventually(() => recordedPid(pidFile), "the command to record its pid");
  await session.close();
  const after: EngineEvent[] = [];
  for await (const event of session.events) after.push(event);
  assert.equal(after.some(isSettled), false, "close emits no settles, so the next start reports the task interrupted");
  await eventually(() => (alive(pid) ? undefined : true), "the command to die");
});

for (const signal of ["SIGKILL", "SIGTERM"] as const) {
  test(`PiEngine: a connector ended by ${signal} leaves no command running`, { skip: process.platform === "win32" }, async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "pi-task-")), "pid");
    const host = spawn(process.execPath, ["--import", "tsx", "test/fixtures/piTaskHost.ts", pidFile], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        host.once("exit", () => reject(new Error("the stand-in connector exited early")));
        host.stdout.on("data", (chunk: Buffer) => chunk.toString().includes("ready") && resolve());
      });
      const pid = await eventually(() => recordedPid(pidFile), "the command to record its pid");
      host.removeAllListeners("exit");
      host.kill(signal);
      await new Promise((r) => host.once("exit", r));
      await eventually(() => (alive(pid) ? undefined : true), "the command to die", 6000);
    } finally {
      host.kill("SIGKILL");
    }
  });
}
