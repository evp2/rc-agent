import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { Usage } from "@earendil-works/pi-ai";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

import type { EngineEvent } from "../types";
import { ChildStream, installedPi, type SubagentCommand, type SubagentSettings, subagentArgs } from "./subagent";

export const MAX_BACKGROUND_TASKS = 4;

const OUTPUT_TAIL_CHARS = 2000;
const KILL_GRACE_MS = 2000;
const CLOSE_WAIT_MS = 200;

export interface FinishedTask {
  taskId: string;
  description: string;
  status: "completed" | "failed" | "stopped";
  summary: string;
  usage?: Usage;
  /** "none" for a foreground call, which returns its result as the tool result, and for a Stop; "note" for a Kill of a shell task. */
  delivery: "run" | "note" | "none";
}

export type StartedTask = { ok: true; taskId: string; finished: Promise<FinishedTask> } | { ok: false; reason: string };

export interface SubagentLauncher {
  command?: SubagentCommand;
  settings(): SubagentSettings;
}

interface Task {
  taskId: string;
  toolUseId: string;
  description: string;
  taskType: "shell" | "subagent";
  foreground: boolean;
  startedAt: number;
  child: ChildProcess;
  settled: boolean;
  exited: boolean;
  released: boolean;
  killTimer?: NodeJS.Timeout;
  output: string;
  stream?: ChildStream;
  finish(task: FinishedTask): void;
}

// SIGKILL of the connector runs no handler, so the group's own watchdog is what ends it.
const WATCHDOG_SCRIPT =
  `(trap '' TERM; while kill -0 "$1" 2>/dev/null && kill -0 $$ 2>/dev/null; do sleep 0.3; done; ` +
  `if ! kill -0 "$1" 2>/dev/null; then kill -s TERM -- "-$$"; sleep 1; kill -s KILL -- "-$$"; fi) & ` +
  `W=$!; shift; "$@"; C=$?; kill -s KILL "$W" 2>/dev/null; exit "$C"`;

const liveGroups = new Set<number>();
const GROUP_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
type GroupSignal = (typeof GROUP_SIGNALS)[number];
let handlersInstalled = false;

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

function endLiveGroups(): void {
  for (const pid of liveGroups) signalGroup(pid, "SIGTERM");
}

// A listener suppresses Node's default exit, so a signal nothing else handles is re-raised.
function onProcessSignal(signal: GroupSignal): void {
  endLiveGroups();
  if (process.listenerCount(signal) === 1) {
    process.removeListener(signal, handlers[signal]);
    process.kill(process.pid, signal);
  }
}

const handlers = Object.fromEntries(GROUP_SIGNALS.map((s) => [s, () => onProcessSignal(s)])) as Record<
  GroupSignal,
  () => void
>;

function trackGroup(pid: number): void {
  liveGroups.add(pid);
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on("exit", endLiveGroups);
  for (const s of GROUP_SIGNALS) process.on(s, handlers[s]);
}

function untrackGroup(pid: number): void {
  liveGroups.delete(pid);
  if (!handlersInstalled || liveGroups.size > 0) return;
  handlersInstalled = false;
  process.removeListener("exit", endLiveGroups);
  for (const s of GROUP_SIGNALS) process.removeListener(s, handlers[s]);
}

function describe(command: string): string {
  const line = command.trim().split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

export class TaskRegistry {
  private readonly tasks = new Map<string, Task>();
  private readonly occupying = new Set<Task>();
  private closed = false;

  constructor(
    private readonly cwd: string,
    private readonly emit: (event: EngineEvent) => void,
    private readonly onFinished: (task: FinishedTask) => void,
    private readonly subagents?: SubagentLauncher,
  ) {}

  startShell(toolUseId: string, command: string, description?: string): StartedTask {
    const shell = getShellConfig();
    return this.start({
      toolUseId,
      taskType: "shell",
      foreground: false,
      description: description?.trim() || describe(command),
      command: shell.shell,
      args: ["-c", command],
    });
  }

  startSubagent(toolUseId: string, prompt: string, description: string, foreground: boolean): StartedTask {
    if (!this.subagents) return { ok: false, reason: "subagents are not available in this session" };
    const launcher = this.subagents;
    const base = launcher.command ?? installedPi();
    return this.start({
      toolUseId,
      taskType: "subagent",
      foreground,
      description: description.trim() || describe(prompt),
      command: base.command,
      args: subagentArgs(base, launcher.settings()),
      stdin: prompt,
    });
  }

  kill(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.exited) return;
    this.end(task);
    this.settle(task, "stopped", this.stoppedSummary(task), task.taskType === "shell" ? "note" : "run");
  }

  stopAll(): void {
    for (const task of [...this.tasks.values()]) {
      this.end(task);
      this.settle(task, "stopped", this.stoppedSummary(task), "none");
    }
  }

  close(): void {
    this.closed = true;
    for (const task of this.tasks.values()) {
      this.end(task);
      task.finish({ taskId: task.taskId, description: task.description, status: "stopped", summary: "stopped", delivery: "none" });
    }
    this.tasks.clear();
  }

  private start(spec: {
    toolUseId: string;
    taskType: Task["taskType"];
    foreground: boolean;
    description: string;
    command: string;
    args: string[];
    stdin?: string;
  }): StartedTask {
    if (this.closed) return { ok: false, reason: "the session is closed" };
    if (this.occupying.size >= MAX_BACKGROUND_TASKS) {
      return {
        ok: false,
        reason: `${MAX_BACKGROUND_TASKS} background tasks are already running, which is the most at once. Wait for one to finish, then try again.`,
      };
    }
    const windows = process.platform === "win32";
    const child = windows
      ? spawn(spec.command, spec.args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
      : spawn("sh", ["-c", WATCHDOG_SCRIPT, "sh", String(process.pid), spec.command, ...spec.args], {
          cwd: this.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });
    let finish!: (task: FinishedTask) => void;
    const finished = new Promise<FinishedTask>((resolve) => (finish = resolve));
    const task: Task = {
      taskId: `${spec.taskType === "shell" ? "shell" : "agent"}-${randomUUID().slice(0, 8)}`,
      toolUseId: spec.toolUseId,
      description: spec.description,
      taskType: spec.taskType,
      foreground: spec.foreground,
      startedAt: Date.now(),
      child,
      settled: false,
      exited: false,
      released: false,
      output: "",
      ...(spec.taskType === "subagent" ? { stream: new ChildStream() } : {}),
      finish,
    };
    this.tasks.set(task.taskId, task);
    this.occupying.add(task);
    if (child.pid !== undefined && !windows) trackGroup(child.pid);

    // A child waits for stdin to end before it starts; a shell command has no use for it.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(spec.stdin ?? "");
    const collect = (chunk: string) => {
      task.output = (task.output + chunk).slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (task.stream ? task.stream.feed(chunk) : collect(chunk)));
    child.stderr?.setEncoding("utf8").on("data", collect);
    child.once("error", (e) => {
      this.release(task);
      this.settle(task, "failed", `could not start: ${e.message}`);
    });
    child.once("exit", (code, signal) => {
      task.exited = true;
      if (child.pid !== undefined && !windows) untrackGroup(child.pid);
      // Output still in the pipes arrives after "exit"; a surviving grandchild can hold them open, so the wait is bounded.
      const settle = () => this.settleExited(task, code, signal);
      const timer = setTimeout(settle, CLOSE_WAIT_MS);
      child.once("close", () => {
        clearTimeout(timer);
        settle();
      });
    });
    child.once("close", () => this.release(task));

    this.emit({
      type: "task_started",
      taskId: task.taskId,
      toolUseId: spec.toolUseId,
      description: task.description,
      taskType: task.taskType,
      ambient: false,
    });
    this.emitLiveSet();
    return { ok: true, taskId: task.taskId, finished };
  }

  private end(task: Task): void {
    const { child } = task;
    if (child.pid === undefined || child.exitCode !== null) return;
    if (process.platform === "win32") {
      child.kill();
      return;
    }
    signalGroup(child.pid, "SIGTERM");
    task.killTimer = setTimeout(() => {
      signalGroup(child.pid!, "SIGKILL");
      setTimeout(() => this.release(task), CLOSE_WAIT_MS).unref();
    }, KILL_GRACE_MS);
    task.killTimer.unref();
  }

  private release(task: Task): void {
    if (task.released) return;
    task.released = true;
    clearTimeout(task.killTimer);
    this.occupying.delete(task);
  }

  private settleExited(task: Task, code: number | null, signal: NodeJS.Signals | null): void {
    const exit = exitSummary(code, signal);
    const tail = task.output.trim();
    if (!task.stream) {
      this.settle(task, code === 0 ? "completed" : "failed", tail ? `${exit}\n${tail}` : exit);
      return;
    }
    task.stream.finish();
    const error = task.stream.error;
    if (code === 0 && !error) {
      this.settle(task, "completed", task.stream.finalText || "finished with no output");
      return;
    }
    this.settle(task, "failed", error ?? (tail ? `${exit}\n${tail}` : exit));
  }

  private stoppedSummary(task: Task): string {
    const tail = task.stream ? "" : task.output.trim();
    return tail ? `stopped\n${tail}` : "stopped";
  }

  private settle(task: Task, status: FinishedTask["status"], summary: string, delivery: FinishedTask["delivery"] = "run"): void {
    if (task.settled) return;
    task.settled = true;
    this.tasks.delete(task.taskId);
    const finished: FinishedTask = {
      taskId: task.taskId,
      description: task.description,
      status,
      summary,
      ...(task.stream ? { usage: task.stream.usage } : {}),
      delivery: task.foreground ? "none" : delivery,
    };
    task.finish(finished);
    if (this.closed) return;
    this.emit({
      type: "task_settled",
      taskId: task.taskId,
      toolUseId: task.toolUseId,
      status,
      summary,
      durationMs: Date.now() - task.startedAt,
      ambient: false,
    });
    this.emitLiveSet();
    this.onFinished(finished);
  }

  private emitLiveSet(): void {
    this.emit({
      type: "tasks_changed",
      tasks: [...this.tasks.values()].map((t) => ({ taskId: t.taskId, taskType: t.taskType, description: t.description })),
    });
  }
}

function exitSummary(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) return `exited with status ${code}`;
  return `killed by ${signal}`;
}
