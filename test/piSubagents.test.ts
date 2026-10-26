import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { fauxAssistantMessage, type FauxResponseStep, type JsonObject, type Usage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { EngineAnswer, EngineEvent, EngineUsage } from "../src/engine/types.ts";
import {
  callingTools,
  type ChildPlan,
  piEngineOn,
  startingShell,
  startingSubagent,
  untilAborted,
  writePiSettings,
} from "./piDoubles.ts";

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

async function openSession(responses: FauxResponseStep[], options: Parameters<typeof piEngineOn>[1] = {}) {
  const pi = piEngineOn(responses, options);
  const session = await pi.engine.open(openOptions(pi.projectDir));
  return { session, it: session.events[Symbol.asyncIterator](), pi };
}

function only<T extends EngineEvent["type"]>(events: EngineEvent[], type: T): Event<T> {
  const found = events.filter((e): e is Event<T> => e.type === type);
  assert.equal(found.length, 1, `exactly one ${type} in ${JSON.stringify(events)}`);
  return found[0];
}

function text(context: { messages: { role: string; content: unknown }[] }): string {
  return JSON.stringify(context.messages.map((m) => m.content));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually<T>(read: () => T | undefined, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface ChildRecord {
  argv: string[];
  cwd: string;
  pid: number;
}

function recordedPid(file: string): number | undefined {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    return pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function recordFile(): string {
  return join(mkdtempSync(join(tmpdir(), "pi-child-")), "record.json");
}

function recorded(file: string): ChildRecord | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ChildRecord;
  } catch {
    return undefined;
  }
}

const dead = (pid: number) => eventually(() => (alive(pid) ? undefined : true), "the child to die", 10_000);

const CHILD_USAGE = { input: 1_000_000, output: 2_000, cacheRead: 30, cacheWrite: 4, cost: 0.5 };

function parentUsage(projectDir: string, conversationId: string): Usage[] {
  const file = SessionManager.findById(projectDir, conversationId);
  assert.ok(file, "Pi kept the session");
  return SessionManager.open(file)
    .getEntries()
    .flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message.usage] : []));
}

function expectedUsage(parent: Usage[]): EngineUsage {
  return {
    inputTokens: parent.reduce((n, u) => n + u.input, 0) + CHILD_USAGE.input,
    outputTokens: parent.reduce((n, u) => n + u.output, 0) + CHILD_USAGE.output,
    cacheReadTokens: parent.reduce((n, u) => n + u.cacheRead, 0) + CHILD_USAGE.cacheRead,
    cacheWriteTokens: parent.reduce((n, u) => n + u.cacheWrite, 0) + CHILD_USAGE.cacheWrite,
    costUsd: parent.reduce((n, u) => n + u.cost.total, 0) + CHILD_USAGE.cost,
  };
}

function assertUsage(actual: EngineUsage | undefined, expected: EngineUsage): void {
  assert.ok(actual, "the Turn reported usage");
  const { costUsd: actualCost, ...tokens } = actual;
  const { costUsd: expectedCost, ...expectedTokens } = expected;
  assert.deepEqual(tokens, expectedTokens);
  assert.ok(Math.abs((actualCost ?? 0) - (expectedCost ?? 0)) < 1e-9, `cost ${actualCost} vs ${expectedCost}`);
}

function conversationId(events: EngineEvent[]): string {
  return only(events, "conversation").id;
}

test("PiEngine: a foreground subagent shows as one task card and its final text is the tool result", async () => {
  let seen = "";
  const { session, it } = await openSession([
    startingSubagent({ say: "found 3 files", delayMs: 100 }, { id: "call-sub", description: "count files" }),
    (context) => {
      seen = text(context);
      return fauxAssistantMessage("it found three");
    },
  ]);
  session.send("delegate it");
  const events = await readUntil(it, isTurnEnd);
  const types = events.map((e) => e.type);
  const started = only(events, "task_started");
  assert.deepEqual(started, {
    type: "task_started",
    taskId: started.taskId,
    toolUseId: "call-sub",
    description: "count files",
    taskType: "subagent",
    ambient: false,
  });
  const settled = only(events, "task_settled");
  assert.equal(settled.taskId, started.taskId);
  assert.equal(settled.toolUseId, "call-sub");
  assert.equal(settled.status, "completed");
  assert.equal(settled.summary, "found 3 files");
  assert.ok((settled.durationMs ?? 0) >= 90, `the settle carries the child's duration: ${settled.durationMs}`);
  assert.equal(settled.ambient, false);
  assert.equal(only(events, "tool_result").text, "found 3 files");
  assert.ok(types.indexOf("task_started") < types.indexOf("task_settled"));
  assert.ok(types.indexOf("task_settled") < types.indexOf("tool_result"), "the Turn waited for the child");
  assert.deepEqual(events.filter((e) => e.type === "tasks_changed").map((e) => (e as Event<"tasks_changed">).tasks.length), [1, 0]);
  assert.equal(events.filter((e) => e.type === "turn_started").length, 1);
  assert.match(seen, /found 3 files/);
  await session.close();
  const after: EngineEvent[] = [];
  for await (const event of session.events) after.push(event);
  assert.equal(after.some((e) => e.type === "turn_started"), false, "a foreground result does not wake the model");
});

test("PiEngine: the child's inner tool calls never reach the phone, only the spawning call shows", async () => {
  const { session, it } = await openSession([
    startingSubagent({ say: "done", inner: true }, { id: "call-sub" }),
    fauxAssistantMessage("ok"),
  ]);
  session.send("delegate it");
  const events = await readUntil(it, isTurnEnd);
  assert.deepEqual(
    events.filter((e) => e.type === "tool_use").map((e) => (e as Event<"tool_use">).name),
    ["subagent"],
  );
  assert.equal(events.filter((e) => e.type === "tool_result").length, 1);
  assert.equal(JSON.stringify(events).includes("inner-secret"), false);
  await session.close();
});

test("PiEngine: a background subagent returns its task id at once and wakes the model with its result", async () => {
  let seen = "";
  const { session, it } = await openSession([
    startingSubagent({ say: "the survey is done", delayMs: 400, inner: true }, { id: "call-sub", description: "survey", background: true }),
    fauxAssistantMessage("started it"),
    (context) => {
      seen = text(context);
      return fauxAssistantMessage("I read the survey");
    },
  ]);
  session.send("survey the repo");
  const first = await readUntil(it, isTurnEnd);
  const started = only(first, "task_started");
  assert.equal(started.taskType, "subagent");
  assert.equal(started.toolUseId, "call-sub");
  assert.ok(only(first, "tool_result").text?.includes(started.taskId));
  assert.equal(first.some(isSettled), false, "the Turn ended while the child still ran");
  assert.deepEqual(first.filter((e) => e.type === "tasks_changed").at(-1), {
    type: "tasks_changed",
    tasks: [{ taskId: started.taskId, taskType: "subagent", description: "survey" }],
  });

  const later = await readUntil(it, isTurnEnd);
  const types = later.map((e) => e.type);
  const settled = only(later, "task_settled");
  assert.equal(settled.taskId, started.taskId);
  assert.equal(settled.status, "completed");
  assert.equal(settled.summary, "the survey is done");
  assert.ok(types.indexOf("task_settled") < types.indexOf("turn_started"));
  assert.equal(only(later, "turn_started").cause, "engine");
  assert.match(seen, /the survey is done/);
  assert.equal(JSON.stringify(later).includes("inner-secret"), false);
  await session.close();
});

test("PiEngine: Kill ends one foreground subagent, the Turn carries on, and a child that ignores terminate is still ended", async () => {
  const record = recordFile();
  let seen = "";
  const { session, it } = await openSession([
    startingSubagent({ hang: true, ignoreTerm: true, record }, { id: "call-sub" }),
    (context) => {
      seen = text(context);
      return fauxAssistantMessage("it was stopped");
    },
  ]);
  session.send("delegate it");
  const head = await readUntil(it, (e) => e.type === "task_started");
  const { taskId } = only(head, "task_started");
  const { pid } = await eventually(() => recorded(record), "the child to start");
  const killedAt = Date.now();
  await session.killTask(taskId);
  const events = await readUntil(it, isTurnEnd);
  assert.ok(Date.now() - killedAt < 1500, "a child that ignores terminate does not hold the Turn");
  assert.equal(only(events, "task_settled").status, "stopped");
  assert.equal(only(events, "tool_result").isError, true);
  assert.equal(only(events, "turn_ended").outcome, "success");
  assert.match(seen, /stopped/);
  await dead(pid);
  await session.close();
});

test("PiEngine: Kill of an unknown or settled task does nothing", async () => {
  const { session, it } = await openSession([
    startingSubagent({ say: "quick" }, { id: "call-sub" }),
    fauxAssistantMessage("ok"),
  ]);
  session.send("go");
  const events = await readUntil(it, isTurnEnd);
  await session.killTask("no-such-task");
  await session.killTask(only(events, "task_started").taskId);
  await session.close();
  const after: EngineEvent[] = [];
  for await (const event of session.events) after.push(event);
  assert.deepEqual(after, []);
});

test("PiEngine: Kill between Turns settles a background subagent stopped and wakes the model with that", async () => {
  const record = recordFile();
  let seen = "";
  const { session, it } = await openSession([
    startingSubagent({ hang: true, record }, { id: "call-sub", background: true }),
    fauxAssistantMessage("started it"),
    (context) => {
      seen = text(context);
      return fauxAssistantMessage("it was killed");
    },
  ]);
  session.send("go");
  const first = await readUntil(it, isTurnEnd);
  const { taskId } = only(first, "task_started");
  const { pid } = await eventually(() => recorded(record), "the child to start");
  await session.killTask(taskId);
  const events = await readUntil(it, isTurnEnd);
  assert.equal(only(events, "task_settled").status, "stopped");
  assert.equal(only(events, "turn_started").cause, "engine");
  assert.match(seen, /stopped/);
  await dead(pid);
  await session.close();
});

test("PiEngine: Stop settles a running foreground subagent stopped before the Turn ends, ends the child and does not wake the model", async () => {
  const record = recordFile();
  const { session, it, pi } = await openSession([
    startingSubagent({ hang: true, ignoreTerm: true, record }, { id: "call-sub" }),
    untilAborted,
    fauxAssistantMessage("woken"),
  ]);
  session.send("go");
  await readUntil(it, (e) => e.type === "task_started");
  const { pid } = await eventually(() => recorded(record), "the child to start");
  session.stop();
  const events = await readUntil(it, isTurnEnd);
  const types = events.map((e) => e.type);
  assert.equal(only(events, "task_settled").status, "stopped");
  assert.ok(types.indexOf("task_settled") < types.indexOf("turn_ended"));
  assert.equal(only(events, "turn_ended").outcome, "stopped");
  await dead(pid);
  const pending = pi.faux.getPendingResponseCount();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(pi.faux.getPendingResponseCount(), pending, "no model call was made after Stop");
  await session.close();
});

test("PiEngine: Stop ends a background subagent that outlived its Turn", async () => {
  const record = recordFile();
  const { session, it } = await openSession([
    startingSubagent({ hang: true, record }, { id: "call-sub", background: true }),
    fauxAssistantMessage("started it"),
  ]);
  session.send("go");
  await readUntil(it, isTurnEnd);
  const { pid } = await eventually(() => recorded(record), "the child to start");
  session.stop();
  await dead(pid);
  await session.close();
});

function backgroundCalls(kinds: ("shell" | "subagent")[]): { name: string; args: JsonObject; id: string }[] {
  return kinds.map((kind, n) => ({
    name: kind === "shell" ? "bash_background" : "subagent",
    args: (kind === "shell"
      ? { command: "sleep 30" }
      : { prompt: JSON.stringify({ hang: true } satisfies ChildPlan), description: "wait", background: true }) as JsonObject,
    id: `call-${n}`,
  }));
}

for (const [name, kinds] of [
  ["shell commands fill the cap before a subagent", ["shell", "shell", "subagent", "subagent", "subagent"]],
  ["subagents fill the cap before a shell command", ["subagent", "subagent", "subagent", "subagent", "shell"]],
] as const) {
  test(`PiEngine: the cap of four is shared, ${name}`, async () => {
    const model = callingTools(backgroundCalls([...kinds]));
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
}

test("PiEngine: a foreground subagent counts toward the cap while it runs", async () => {
  const calls: { name: string; args: JsonObject; id: string }[] = [
    ...backgroundCalls(["shell", "shell", "shell"]),
    { name: "subagent", args: { prompt: JSON.stringify({ hang: true }), description: "fg" }, id: "call-fg" },
    { name: "subagent", args: { prompt: JSON.stringify({ say: "x" }), description: "late" }, id: "call-late" },
  ];
  const model = callingTools(calls);
  const { session, it } = await openSession(model.steps);
  session.send("go");
  const head = await readUntil(it, (e) => e.type === "task_started" && e.toolUseId === "call-fg");
  await new Promise((r) => setTimeout(r, 300));
  await session.killTask((head.at(-1) as Event<"task_started">).taskId);
  await readUntil(it, isTurnEnd);
  assert.match(model.results().get("call-late")?.text ?? "", /4 background tasks/);
  session.stop();
  await session.close();
});

test("PiEngine: a child that fails settles failed and a foreground call gets the error", async () => {
  const { session, it } = await openSession([
    startingSubagent({ say: "", exit: 3, stderr: "boom happened" }, { id: "call-sub" }),
    fauxAssistantMessage("it failed"),
  ]);
  session.send("go");
  const events = await readUntil(it, isTurnEnd);
  const settled = only(events, "task_settled");
  assert.equal(settled.status, "failed");
  assert.match(settled.summary ?? "", /boom happened/);
  const result = only(events, "tool_result");
  assert.equal(result.isError, true);
  assert.match(result.text ?? "", /boom happened/);
  await session.close();
});

test("PiEngine: the child gets the session's directory, model and credentials-bearing environment, built-in tools only, and no stored session", async () => {
  const record = recordFile();
  const { session, it, pi } = await openSession([
    startingSubagent({ say: "ok", record }, { id: "call-sub" }),
    fauxAssistantMessage("fine"),
  ]);
  session.send("go");
  await readUntil(it, isTurnEnd);
  const child = recorded(record)!;
  assert.equal(child.cwd, realpathSync(pi.projectDir));
  const flag = (name: string) => child.argv[child.argv.indexOf(name) + 1];
  assert.ok(child.argv.includes("--no-session"), "the child writes no session to the developer's Pi session list");
  assert.ok(child.argv.includes("--no-extensions"), "no codemode, MCP or named agents");
  assert.equal(flag("--mode"), "json");
  assert.ok(child.argv.includes("-p"));
  assert.equal(flag("--tools"), "read,bash,edit,write");
  assert.equal(flag("--model"), "anthropic/faux-model");
  assert.ok(flag("--thinking"));
  await session.close();
});

test("PiEngine: a real pi child accepts the connector's flags and leaves the session list alone", { timeout: 30_000 }, async () => {
  const sessions = join(process.env.PI_CODING_AGENT_DIR!, "sessions");
  const count = () => (existsSync(sessions) ? readdirSync(sessions, { recursive: true }).filter((f) => String(f).endsWith(".jsonl")).length : 0);
  const before = count();
  const { session, it } = await openSession(
    [startingSubagent({}, { id: "call-sub" }), fauxAssistantMessage("it failed")],
    { realChild: true },
  );
  session.send("go");
  const events = await readUntil(it, isTurnEnd, 25_000);
  const settled = only(events, "task_settled");
  assert.equal(settled.status, "failed");
  assert.doesNotMatch(settled.summary ?? "", /unknown option|unrecognized/i);
  assert.equal(count() - before, 1, "only the parent's own session was written, the child added none");
  await session.close();
});

test("PiEngine: the child's usage is added to the Turn that waited for it", async () => {
  const { session, it, pi } = await openSession([
    startingSubagent({ say: "done", usage: CHILD_USAGE }, { id: "call-sub" }),
    fauxAssistantMessage("ok"),
  ]);
  session.send("go");
  const events = await readUntil(it, isTurnEnd);
  assertUsage(only(events, "turn_ended").usage, expectedUsage(parentUsage(pi.projectDir, conversationId(events))));
  await session.close();
});

test("PiEngine: a background child's usage goes to the Turn open when it settles", async () => {
  const { session, it, pi } = await openSession([
    startingSubagent({ say: "early", usage: CHILD_USAGE }, { id: "call-sub", background: true }),
    async () => {
      await new Promise((r) => setTimeout(r, 700));
      return fauxAssistantMessage("still working");
    },
    fauxAssistantMessage("saw it"),
  ]);
  session.send("go");
  const events = await readUntil(it, isTurnEnd);
  assert.ok(events.some(isSettled), "the child settled while the Turn was open");
  assertUsage(only(events, "turn_ended").usage, expectedUsage(parentUsage(pi.projectDir, conversationId(events))));
  await session.close();
});

test("PiEngine: a background child's usage goes to the wake Turn when no Turn is open", async () => {
  const { session, it, pi } = await openSession([
    startingSubagent({ say: "late", delayMs: 400, usage: CHILD_USAGE }, { id: "call-sub", background: true }),
    fauxAssistantMessage("started it"),
    fauxAssistantMessage("I read it"),
  ]);
  session.send("go");
  const first = await readUntil(it, isTurnEnd);
  const second = await readUntil(it, isTurnEnd);
  const firstUsage = only(first, "turn_ended").usage!;
  const secondUsage = only(second, "turn_ended").usage!;
  assert.ok(firstUsage.inputTokens < CHILD_USAGE.input, "the first Turn ended before the child did");
  const total = expectedUsage(parentUsage(pi.projectDir, conversationId(first)));
  assert.equal(firstUsage.inputTokens + secondUsage.inputTokens, total.inputTokens);
  assert.ok(secondUsage.inputTokens >= CHILD_USAGE.input);
  assert.equal(firstUsage.outputTokens + secondUsage.outputTokens, total.outputTokens);
  await session.close();
});

test("PiEngine: usage of a child that Stop ended with no Turn open is dropped, not billed to a later Turn", async () => {
  const record = recordFile();
  const { session, it } = await openSession([
    startingSubagent({ hang: true, usage: CHILD_USAGE, record }, { id: "call-sub", background: true }),
    fauxAssistantMessage("started it"),
    fauxAssistantMessage("unrelated answer"),
  ]);
  session.send("go");
  await readUntil(it, isTurnEnd);
  const { pid } = await eventually(() => recorded(record), "the child to start");
  await new Promise((r) => setTimeout(r, 300));
  session.stop();
  await dead(pid);
  session.send("something else");
  const events = await readUntil(it, isTurnEnd);
  assert.ok(only(events, "turn_ended").usage!.inputTokens < CHILD_USAGE.input, "the stopped child's usage is not in this Turn");
  await session.close();
});

test("PiEngine: the cap counts a killed task until its process has exited", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cap-"));
  const files = [0, 1, 2, 3].map((n) => join(dir, `pid-${n}`));
  const calls = files.map((file, n) => ({
    name: "bash_background",
    args: { command: `trap '' TERM; echo $$ > ${file}; while :; do sleep 1; done` } as JsonObject,
    id: `call-${n}`,
  }));
  const model = callingTools(calls);
  const { session, it } = await openSession([
    ...model.steps,
    startingShell("echo extra", "call-extra"),
    fauxAssistantMessage("tried"),
    startingShell("echo retry", "call-retry"),
    fauxAssistantMessage("tried again"),
  ]);
  session.send("start four");
  const first = await readUntil(it, isTurnEnd);
  const pids = files.map((f) => eventually(() => recordedPid(f), "a task to start"));
  const [firstPid] = await Promise.all(pids);
  await session.killTask(first.find((e): e is Event<"task_started"> => e.type === "task_started")!.taskId);
  session.send("one more");
  const during = await readUntil(it, isTurnEnd);
  assert.match(only(during, "tool_result").text ?? "", /4 background tasks/);
  await eventually(() => (alive(firstPid) ? undefined : true), "the killed task to exit", 10_000);
  session.send("and again");
  const after = await readUntil(it, isTurnEnd);
  assert.equal(only(after, "tool_result").isError, false);
  session.stop();
  await session.close();
});

test("PiEngine: closing the session ends a subagent and reports no settle", { skip: process.platform === "win32" }, async () => {
  const record = recordFile();
  const { session, it } = await openSession([startingSubagent({ hang: true, record }, { id: "call-sub" }), untilAborted]);
  session.send("go");
  await readUntil(it, (e) => e.type === "task_started");
  const { pid } = await eventually(() => recorded(record), "the child to start");
  await session.close();
  const after: EngineEvent[] = [];
  for await (const event of session.events) after.push(event);
  assert.equal(after.some(isSettled), false, "close emits no settles, so the next start reports the task interrupted");
  await dead(pid);
});

for (const signal of ["SIGKILL", "SIGTERM"] as const) {
  test(`PiEngine: a connector ended by ${signal} leaves no subagent running`, { skip: process.platform === "win32" }, async () => {
    const record = recordFile();
    const host = spawn(process.execPath, ["--import", "tsx", "test/fixtures/piTaskHost.ts", record, "subagent"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        host.once("exit", () => reject(new Error("the stand-in connector exited early")));
        host.stdout.on("data", (chunk: Buffer) => chunk.toString().includes("ready") && resolve());
      });
      const { pid } = await eventually(() => recorded(record), "the child to start");
      host.removeAllListeners("exit");
      host.kill(signal);
      await new Promise((r) => host.once("exit", r));
      await eventually(() => (alive(pid) ? undefined : true), "the child to die", 6000);
    } finally {
      host.kill("SIGKILL");
    }
  });
}
