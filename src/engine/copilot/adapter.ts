import type { PermissionHandler, SessionEvent, Tool, ToolResultObject } from "@github/copilot-sdk";

import { homedir } from "node:os";
import { join, sep } from "node:path";

import { AsyncQueue } from "../../asyncQueue";
import { PERMISSION_MODE } from "../../config";
import type { CopilotProviderConfig } from "../../provider";
import type { SkillInfo } from "../../relay/client";
import {
  forwardShowImage,
  IMAGE_SHOWN,
  SHOW_IMAGE_CAPTION_DESCRIPTION,
  SHOW_IMAGE_DESCRIPTION,
  SHOW_IMAGE_PATH_DESCRIPTION,
} from "../showImageTool";
import type { Engine, EngineEvent, EngineQuestion, EngineSession, EngineUsage, OpenOptions } from "../types";
import { chooseEffort, chooseModel, type ModelPickerDeps } from "./modelPicker";
import {
  startCopilotRuntime,
  type CopilotCommand,
  type CopilotCommandResult,
  type CopilotRuntime,
  type CopilotSessionHandle,
  type CopilotSessionOptions,
  type CopilotSkill,
  type CopilotTask,
  type CopilotUserInputRequest,
  type CopilotUserInputResponse,
} from "./runtime";

type QuestionItem = EngineQuestion["questions"][number];

export interface CopilotEngineDeps {
  /** Starts the Copilot runtime. Called at most once per Engine. */
  startRuntime: () => Promise<CopilotRuntime>;
  model: string;
}

/** Builds a Copilot adapter on the runtime the provider config names. */
export function createCopilotEngine(provider: CopilotProviderConfig): Engine {
  return new CopilotEngine({ startRuntime: () => startCopilotRuntime(provider), model: provider.model });
}

/**
 * Approves every permission request, the way the connector runs Claude.
 *
 * The SDK's own `approveAll` throws whenever managed settings are in force,
 * which would fail every tool call on a managed machine. This one approves
 * whatever the policy lets a client approve, and leaves anything the policy
 * reserves for itself to the policy.
 */
export const approveEverything: PermissionHandler = (request) => {
  const managed = (request as { managedApprovalRequired?: unknown }).managedApprovalRequired;
  if (managed !== undefined && managed !== false) return { kind: "no-result" };
  return { kind: "approve-once" };
};

/**
 * The `show_image` tool, run in this process when the model calls it. The
 * handler only forwards: what happens to the file is the connector's
 * business, behind `onShowImage`.
 */
function showImageTool(onShowImage: NonNullable<OpenOptions["onShowImage"]>): Tool {
  const failure = (reason: string): ToolResultObject => ({
    textResultForLlm: reason,
    resultType: "failure",
    error: reason,
  });
  return {
    name: "show_image",
    description: SHOW_IMAGE_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: SHOW_IMAGE_PATH_DESCRIPTION },
        caption: { type: "string", description: SHOW_IMAGE_CAPTION_DESCRIPTION },
      },
      required: ["path"],
    },
    // Nothing to approve: it only shows the human a file, and every other
    // tool is approved anyway.
    skipPermission: true,
    defer: "never",
    handler: async (args, invocation): Promise<ToolResultObject> => {
      const { path, caption } = (args ?? {}) as { path?: unknown; caption?: unknown };
      if (typeof path !== "string" || !path) return failure("the image couldn't be shown: no path was given");
      const outcome = await forwardShowImage(
        onShowImage,
        { toolUseId: invocation.toolCallId, path, ...(typeof caption === "string" && caption ? { caption } : {}) },
        // Aborted once Copilot is done with the call, or the session disconnects.
        invocation.signal ?? new AbortController().signal,
      );
      return outcome.shown ? { textResultForLlm: IMAGE_SHOWN, resultType: "success" } : failure(outcome.reason);
    },
  };
}

type TurnOutcome = Extract<EngineEvent, { type: "turn_ended" }>["outcome"];

/** A Command or Steer that never ran, to be reported once the running Turn has ended. */
interface Unrun {
  cause: "command" | "steer";
  outcome: "stopped" | "error";
  errors?: string[];
}

/** A Background task reported started and not yet settled. */
interface LiveTask {
  taskType: string;
  description?: string;
  /** The tool call that started it, when it can be told. */
  toolUseId?: string;
}

interface RunningTurn {
  startedAt: number;
  usage: EngineUsage | undefined;
  errors: string[];
  /**
   * Set while a Local command's call runs. Copilot works some commands
   * through prompts of its own, and whatever they show belongs to this Turn,
   * which ends when the call returns.
   */
  localCommand?: boolean;
  /** Set once a Local command has handed the agent a prompt, whose user message continues this Turn. */
  promptPending?: boolean;
  /** Set once the Turn has reported a compaction, which a `/compact`'s own text would only repeat. */
  compacted?: boolean;
  /** Set while it runs a Local command of the connector's own, which Copilot has no part in. */
  ownCommand?: boolean;
}

/** Said against every Command the connector can no longer hand to Copilot. */
const RUNTIME_GONE = "the Copilot runtime exited";

/** Copilot's own question tool. Its questions reach the human through `onQuestion`, never as a tool call. */
const QUESTION_TOOL = "ask_user";

/**
 * One long-lived Copilot session, translated into neutral Engine events.
 *
 * A Copilot Turn starts with the user message it answers, or, when the agent
 * goes back to work on its own (a detached shell finishing, say), with the
 * first sign of that work. It ends on the main agent loop going idle, or on
 * an abort. Copilot's own `assistant.turn_start`/`turn_end` mark model calls
 * within a Turn, not Turns.
 *
 * Commands are handed to Copilot one at a time, only while it is idle; any
 * sent meanwhile wait here. That keeps each Turn's cause certain, and lets a
 * Stop drop the waiting ones without depending on what Copilot does with its
 * own queue on an abort.
 *
 * A Steer is the one prompt handed over mid-Turn. It waits in Copilot's own
 * queue while any tool call already running finishes; then the main turn is
 * interrupted, and Copilot runs the queued Steer in its place. That cuts the
 * Turn at the same tool-call boundary Claude's Steer does. Copilot's own
 * "immediate" steering is never used: it adds the message to the Turn rather
 * than cutting it, and whether the rest of the Turn still runs is up to the
 * model.
 */
class CopilotEngineSession implements EngineSession {
  private readonly outbox = new AsyncQueue<EngineEvent>();
  /** Commands waiting for Copilot to go idle. */
  private readonly waiting: string[] = [];
  /** Commands and Steers that won't run, each reported once the Turn still running has ended. */
  private readonly unrunAfterTurn: Unrun[] = [];
  /** A Command handed to Copilot whose user message hasn't come back yet. */
  private delivering = false;
  /** Set by a Stop that landed while a Command or Steer was being handed over: its Turn is aborted as soon as it starts. */
  private abortWhenStarted = false;
  /** A Steer handed to Copilot whose user message hasn't come back yet. */
  private steerText: string | undefined;
  /** Set once Copilot has taken that Steer into its queue. */
  private steerQueued = false;
  /** Set once that Steer has been handed over a second time, after Copilot dropped it. */
  private steerResent = false;
  /** Set while a Steer waits for the tool calls already running to finish before it cuts the Turn. */
  private cutAtToolBoundary = false;
  /** A model announced between Turns, held for the next one. */
  private heldAnnouncement: string | undefined;
  /** The main agent's tool calls that have started and not yet returned. */
  private readonly runningTools = new Set<string>();
  private turn: RunningTurn | undefined;
  private contextPercentage: number | undefined;
  /** Background tasks reported started and not yet settled. */
  private readonly liveTasks = new Map<string, LiveTask>();
  /** Every task id ever reported, so none is reported twice. */
  private readonly seenTasks = new Set<string>();
  /**
   * Tool calls that started a detached shell, with the command each ran.
   * Copilot lists a shell without the call that started it, so a listed
   * shell is matched back to its call by that command.
   */
  private readonly detachedShellCalls = new Map<string, string>();
  /** Detached shells a Stop or Kill ended, whose completion Copilot has yet to report. */
  private readonly shellsKilled = new Set<string>();
  /** Set when one of those completions arrives: the Turn it wakes the agent into is aborted unseen. */
  private quellNextWake = false;
  /** True from the first sign of a quelled wake-up until Copilot confirms it stopped. */
  private quelling = false;
  private refreshingTasks: Promise<void> | undefined;
  private tasksStale = false;
  /**
   * Every slash command there is, by lower-cased name and alias: Copilot's,
   * once read, and from the start the connector's own, which need nothing of
   * Copilot's list to run.
   */
  private commands = commandsByName(withOwnCommands([]));
  /** Set once Copilot's command list has been read at all. */
  private commandsRead = false;
  /** Set while the command list is re-read for the Command next in line. */
  private rereadingCommands = false;
  private refreshingMenu: Promise<void> | undefined;
  private menuStale = false;
  /** Calls of the question tool, whose start and result are kept off the phone. */
  private readonly questionCalls = new Set<string>();
  /**
   * Question-tool calls started whose question hasn't been put to the human
   * yet, with the question each asks. Copilot's question handler isn't told
   * which call it serves, and several can be asking at once, so a question
   * is matched to its call by what it asks.
   */
  private readonly unaskedQuestionCalls = new Map<string, string | undefined>();
  /** Questions matched to no call, each keyed apart all the same. */
  private unmatchedQuestions = 0;
  /** One per Question waiting on the human; a Stop or close withdraws them all. */
  private readonly pendingQuestions = new Set<AbortController>();
  /** Questions the connector asks itself, each keyed apart from the rest. */
  private ownQuestions = 0;
  /**
   * The model the connector just switched to, whose announcement it leaves
   * out: the status line it shows already says so.
   */
  private switchedTo: string | undefined;
  private dead = false;
  private closed = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly runtime: CopilotRuntime,
    private readonly session: CopilotSessionHandle,
    private readonly options: OpenOptions,
    conversation: Extract<EngineEvent, { type: "conversation" }>,
  ) {
    this.outbox.push(conversation);
    this.unsubscribe = session.on((e) => this.handle(e));
    session.onDisconnected(() => this.runtimeGone());
  }

  /**
   * Reads Copilot's Skills and slash commands into the menu, and into the
   * list a Command is checked against to tell a Local command from a prompt.
   * Copilot's change notifications carry nothing, so each one re-reads both,
   * collapsing a burst into one read plus one more if any arrived meanwhile.
   * Resolves once the lists are current.
   */
  refreshMenu(): Promise<void> {
    if (this.refreshingMenu) {
      this.menuStale = true;
      return this.refreshingMenu;
    }
    this.refreshingMenu = (async () => {
      do {
        this.menuStale = false;
        try {
          const [skills, listed] = await Promise.all([this.session.listSkills(), this.session.listCommands()]);
          if (this.closed) return;
          const commands = withOwnCommands(listed);
          this.commands = commandsByName(commands);
          this.commandsRead = true;
          this.outbox.push({
            type: "menu",
            skills: skills.filter(isMenuSkill).map(skillInfo),
            localCommands: menuCommands(commands).map(commandInfo),
          });
        } catch (e) {
          console.error("Failed to list Copilot's Skills and commands:", (e as Error).message);
        }
      } while (this.menuStale && !this.closed);
      this.refreshingMenu = undefined;
    })();
    return this.refreshingMenu;
  }

  get events(): AsyncIterable<EngineEvent> {
    return this.outbox;
  }

  send(text: string): void {
    if (this.closed) return;
    if (this.dead) {
      this.reportUnrun({ cause: "command", outcome: "error", errors: [RUNTIME_GONE] });
      return;
    }
    this.waiting.push(text);
    this.deliverNext();
  }

  steer(text: string): void {
    if (!this.turn || this.quelling || this.dead || this.closed) throw new Error("there is no running Turn to Steer");
    // Copilot runs a Local command through a call of its own, not as a
    // prompt, so there is nothing to queue behind the Turn; and a Local
    // command's own Turn has no main turn to cut.
    if (this.asLocalCommand(text) || this.turn.localCommand) {
      throw new Error("a Local command runs as a Turn of its own on Copilot");
    }
    if (this.steerText !== undefined) throw new Error("a Steer is already on its way into this Turn");
    this.steerText = text;
    this.queueSteer(text);
  }

  /** Hands the Steer to Copilot, and once it is queued behind the running Turn, cuts that Turn. */
  private queueSteer(text: string): void {
    this.session.send(text).then(
      () => {
        if (this.steerText !== text) return;
        this.steerQueued = true;
        if (!this.turn) return;
        // Cutting now would cancel a tool call mid-run, which goes further
        // than a Steer does; the cut waits for the tool-call boundary.
        if (this.runningTools.size) this.cutAtToolBoundary = true;
        else this.cut();
      },
      (e) => {
        if (this.steerText !== text) return;
        this.clearSteer();
        const unrun: Unrun = { cause: "steer", outcome: "error", errors: [(e as Error).message] };
        if (this.turn) this.unrunAfterTurn.push(unrun);
        else this.reportUnrun(unrun);
      },
    );
  }

  private clearSteer(): void {
    this.steerText = undefined;
    this.steerQueued = false;
    this.steerResent = false;
  }

  /**
   * Copilot runs a queued prompt as soon as the Turn ahead of it ends, without
   * going idle in between (measured); going idle with the Steer still queued
   * means Copilot dropped it. Left alone, it would hold back every Command
   * after it. It is handed over once more, to run as the Steer's own Turn --
   * unless a Stop has landed since, or Copilot drops it again, and then it is
   * reported as never run.
   */
  private steerDropped(): void {
    const text = this.steerText!;
    this.steerQueued = false;
    if (!this.abortWhenStarted && !this.steerResent) {
      this.steerResent = true;
      this.queueSteer(text);
      return;
    }
    this.clearSteer();
    const stopped = this.abortWhenStarted;
    this.abortWhenStarted = false;
    this.reportUnrun(
      stopped
        ? { cause: "steer", outcome: "stopped" }
        : { cause: "steer", outcome: "error", errors: ["Copilot dropped the Steer without running it"] },
    );
    for (const unrun of this.unrunAfterTurn.splice(0)) this.reportUnrun(unrun);
    this.deliverNext();
  }

  /**
   * Copilot's question tool, put to the human. Its single question with
   * choices becomes a one-question Question, keyed by the tool call that
   * asked it -- or, matched to none, by a key of its own rather than another
   * call's. Rejects once the Question is withdrawn, which fails the tool;
   * by then the Turn it held has been stopped.
   */
  async ask(request: CopilotUserInputRequest): Promise<CopilotUserInputResponse> {
    if (this.closed || !this.turn) throw new Error("there is no Turn to ask a question in");
    const choices = request.choices ?? [];
    const text = await this.putQuestion(
      this.questionCallAsking(request.question) ?? `${QUESTION_TOOL}-unmatched-${++this.unmatchedQuestions}`,
      { question: request.question, options: choices.map((label) => ({ label })), multiSelect: false },
    );
    return { answer: text, wasFreeform: !choices.includes(text) };
  }

  /**
   * Puts one question to the human as a one-question Question, resolving
   * with the option picked -- or the text typed, which stands in for a pick,
   * as it does in the phone's picker. Rejects once the Question is withdrawn.
   */
  private async putQuestion(toolUseId: string, question: QuestionItem): Promise<string> {
    const withdraw = new AbortController();
    this.pendingQuestions.add(withdraw);
    try {
      const answer = await this.options.onQuestion({ toolUseId, questions: [question] }, withdraw.signal);
      return answer.response?.trim() || answer.answers[question.question] || "";
    } finally {
      this.pendingQuestions.delete(withdraw);
    }
  }

  /** The earliest question-tool call still waiting to ask `question`, now spent. */
  private questionCallAsking(question: string): string | undefined {
    for (const [toolCallId, asks] of this.unaskedQuestionCalls) {
      if (asks !== question) continue;
      this.unaskedQuestionCalls.delete(toolCallId);
      return toolCallId;
    }
    return undefined;
  }

  stop(): void {
    this.withdrawQuestions();
    const dropped = this.waiting.splice(0);
    // Reported before the stopped Turn ends, so everything a Stop did is
    // visible before the phone hears that Turn is over.
    if (this.liveTasks.size) {
      for (const taskId of [...this.liveTasks.keys()]) this.settleTask(taskId, "stopped");
      this.reportLiveTasks();
    }

    const droppedUnrun = dropped.map((): Unrun => ({ cause: "command", outcome: "stopped" }));
    if (this.turn?.localCommand) {
      // Its call can't be taken back, but its Turn ends here; whatever it
      // returns is dropped. One of the connector's own has nothing of
      // Copilot's running.
      const own = this.turn.ownCommand;
      this.unrunAfterTurn.push(...droppedUnrun);
      this.endTurn("stopped");
      if (!own) void this.abort();
    } else if (this.turn?.promptPending || (!this.turn && (this.delivering || this.steerText !== undefined))) {
      // Handed over but not yet started, there is nothing yet to abort.
      this.unrunAfterTurn.push(...droppedUnrun);
      this.abortWhenStarted = true;
    } else if (this.turn) {
      if (this.steerText !== undefined) {
        // Copilot drops its queue on an abort, the Steer included.
        this.clearSteer();
        this.cutAtToolBoundary = false;
        this.unrunAfterTurn.push({ cause: "steer", outcome: "stopped" });
      }
      this.unrunAfterTurn.push(...droppedUnrun);
      void this.abort();
    } else {
      for (const unrun of droppedUnrun) this.reportUnrun(unrun);
    }
    // Detached shells, background agents and schedules survive an abort, and
    // would wake the agent back into the work the human just stopped.
    void this.cancelBackgroundTasks();
  }

  /**
   * Ends one Background task. The Turn, if one is running, carries on. The
   * task is settled here as stopped, whatever Copilot goes on to list it as:
   * a detached shell Copilot can't cancel is signalled instead, and Copilot
   * then reports it completed.
   */
  async killTask(taskId: string): Promise<void> {
    const taskType = this.liveTasks.get(taskId)?.taskType;
    if (taskType === "shell") this.shellsKilled.add(taskId);
    if (taskType === "schedule") await this.session.stopSchedule(scheduleIdOf(taskId)).catch(() => undefined);
    else await this.session.cancelTask(taskId).catch(() => undefined);
    if (this.settleTask(taskId, "stopped")) this.reportLiveTasks();
  }

  /**
   * Ends the Background tasks still running too, since they would outlive the
   * connector -- Copilot's runtime going away leaves a detached shell running,
   * and a resumed session doesn't list it, while a schedule comes back with
   * the resumed session and fires again. None is reported settled: the
   * next start reports each as interrupted by the restart.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.withdrawQuestions();
    if (this.turn) this.endTurn("stopped");
    if (!this.dead) await this.cancelBackgroundTasks();
    await this.session.disconnect().catch(() => undefined);
    await this.runtime.stop().catch(() => undefined);
    this.outbox.close();
  }

  private withdrawQuestions(): void {
    for (const withdraw of this.pendingQuestions) withdraw.abort();
    this.pendingQuestions.clear();
  }

  private deliverNext(commandsReread = false): void {
    if (this.turn || this.quelling || this.delivering || this.steerText !== undefined || this.dead || this.closed) return;
    if (this.rereadingCommands) return;
    const text = this.waiting[0];
    if (text === undefined) return;
    if (!this.commandsRead && !commandsReread && text.trim().startsWith("/")) {
      // With no command list, a Local command -- `/compact`, Auto-compact's
      // included -- would go to the model as plain text, which Copilot never
      // runs as a command. The list is read again first; should that fail
      // too, the Command goes on as it stands.
      this.rereadingCommands = true;
      void this.refreshMenu().then(() => {
        this.rereadingCommands = false;
        this.deliverNext(true);
      });
      return;
    }
    this.waiting.shift();
    const local = this.asLocalCommand(text);
    if (local) {
      this.runLocalCommand(local.name, local.input);
      return;
    }
    this.delivering = true;
    this.session.send(text).catch((e) => {
      if (!this.delivering) return;
      this.delivering = false;
      this.reportUnrun({ cause: "command", outcome: "error", errors: [(e as Error).message] });
      this.deliverNext();
    });
  }

  /**
   * The Local command `text` names, if it names one Copilot lists. Copilot
   * hands any other text, slash or not, to the model as it stands -- and so
   * would it a Local command, since slash commands only run through the
   * command call (measured).
   */
  private asLocalCommand(text: string): { name: string; input?: string } | undefined {
    const match = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
    const command = match && this.commands.get(match[1].toLowerCase());
    if (!command) return undefined;
    return { name: command.name, ...(match[2] ? { input: match[2] } : {}) };
  }

  /** Runs a Local command as a Turn of its own, which ends when Copilot's call returns. */
  private runLocalCommand(name: string, input: string | undefined): void {
    this.startTurn("command");
    const turn = this.turn!;
    turn.localCommand = true;
    if (this.commands.get(name)?.kind === CONNECTOR_KIND) {
      this.runOwnCommand(turn, name, input);
      return;
    }
    this.session.invokeCommand(name, input).then(
      (result) => this.localCommandReturned(turn, name, result),
      (e) => {
        if (this.turn !== turn) return;
        turn.errors.push(copilotMessage(e));
        this.endTurn("error");
      },
    );
  }

  /** Runs one of the connector's own Local commands, ending its Turn with the status line it gives. */
  private runOwnCommand(turn: RunningTurn, name: string, input: string | undefined): void {
    turn.ownCommand = true;
    OWN_COMMANDS.find((c) => c.name === name)!.run(this.pickerDeps(turn), input).then(
      (text) => {
        if (this.turn !== turn) return;
        this.outbox.push({ type: "status", text });
        this.endTurn("success");
      },
      (e) => {
        if (this.turn !== turn) return;
        turn.errors.push(copilotMessage(e));
        this.endTurn("error");
      },
    );
  }

  /**
   * What the picker needs, for the Turn `turn`. Once that Turn has ended --
   * stopped while Copilot was still listing its models, say -- the picker
   * asks nothing more and switches nothing.
   */
  private pickerDeps(turn: RunningTurn): ModelPickerDeps {
    const running = () => {
      if (this.turn !== turn) throw new Error("the Turn has ended");
    };
    return {
      listModels: () => this.runtime.listModels(),
      current: () => this.session.currentModel(),
      switchTo: async (choice) => {
        running();
        const before = await this.session.currentModel();
        running();
        // Copilot announces only a change of model, and never `auto` on its
        // own: the model it picks is announced per Turn.
        const changes = choice.modelId !== before.modelId && choice.modelId !== "auto";
        this.switchedTo = changes ? choice.modelId : undefined;
        try {
          await this.session.switchModel(choice);
        } catch (e) {
          this.switchedTo = undefined;
          throw e;
        }
      },
      ask: async (question) => {
        running();
        return this.putQuestion(`connector-question-${++this.ownQuestions}`, question);
      },
    };
  }

  /**
   * Shows what a Local command returned. Text output reads fine as a status
   * line (measured: plain text, some of it Markdown or a small text chart).
   * A Skill's command returns the prompt the agent is to run, which is sent
   * on, and the Turn then ends the way any prompt's does.
   */
  private localCommandReturned(turn: RunningTurn, name: string, result: CopilotCommandResult): void {
    if (this.turn !== turn) return;
    turn.localCommand = false;
    const status = (text: string | undefined) => text && this.outbox.push({ type: "status", text });
    switch (result.kind) {
      case "agent-prompt":
        status(result.notice);
        turn.promptPending = true;
        this.session.send(result.prompt).catch((e) => {
          if (this.turn !== turn) return;
          turn.errors.push(copilotMessage(e));
          this.endTurn("error");
        });
        return;
      case "text":
        if (!turn.compacted) status(result.text);
        break;
      case "completed":
        // The connector's own `/clear` completes with nothing to say; the
        // phone is told what Claude's says.
        status(result.message ?? (name === "clear" ? "conversation cleared" : undefined));
        break;
      case "add-timeline-entry":
        status(result.entry.text);
        break;
      case "select-subcommand":
        status(`${result.title}: ${result.options.map((o) => `/${result.command} ${o.name}`).join(", ")}`);
        break;
      default:
        status(`/${name} needs Copilot's own terminal`);
    }
    this.endTurn(turn.errors.length ? "error" : "success");
  }

  /** Interrupts the main turn; Copilot then runs the queued Steer as the next one. */
  private cut(): void {
    this.cutAtToolBoundary = false;
    this.session.interruptMainTurn().catch((e) => {
      // The Steer stays queued, and runs once the Turn ends on its own; if
      // Copilot drops it instead, the idle that follows hands it over again.
      console.error("Failed to cut the Copilot Turn for a Steer:", (e as Error).message);
    });
  }

  private async abort(): Promise<void> {
    try {
      await this.session.abort();
    } catch (e) {
      // No abort event is coming to end the Turn, so end it here.
      console.error("Failed to abort the Copilot Turn:", (e as Error).message);
      if (this.turn) this.endTurn("stopped");
    }
  }

  private async cancelBackgroundTasks(): Promise<void> {
    const tasks = await this.session.listTasks().catch((): CopilotTask[] => []);
    for (const task of tasks.filter((t) => isBackgroundTask(t) && isRunning(t))) {
      if (task.type === "shell") this.shellsKilled.add(task.id);
      await this.session.cancelTask(task.id).catch(() => undefined);
    }
    const schedules = await this.session.listSchedules().catch((): number[] => []);
    for (const id of schedules) await this.session.stopSchedule(id).catch(() => undefined);
  }

  private handle(event: SessionEvent): void {
    if (this.closed) return;
    const data = event.data as Record<string, unknown>;
    // A sub-agent's own messages and tool calls belong to the task running
    // it, not to the Turn.
    if (typeof data.parentToolCallId === "string") return;

    if (this.quelling) {
      if (event.type === "abort" || event.type === "assistant.idle") {
        this.quelling = false;
        this.deliverNext();
      }
      return;
    }

    switch (event.type) {
      case "system.notification": {
        const kind = event.data.kind as { type?: string; shellId?: string; agentId?: string; status?: string };
        if (kind.type === "shell_detached_completed" && kind.shellId) {
          // Arriving mid-Turn, the news just joins that Turn; only between
          // Turns does it wake the agent.
          if (this.shellsKilled.delete(kind.shellId)) this.quellNextWake = !this.turn;
          // Settled now, however far Copilot's list lags, so the Turn this
          // wakes the agent into can say what woke it. Copilot calls a
          // finished shell completed whatever its exit code (measured).
          else if (this.settleTask(kind.shellId, "completed")) this.reportLiveTasks();
        } else if (kind.type === "agent_completed" && kind.agentId) {
          if (this.settleTask(kind.agentId, kind.status === "failed" ? "failed" : "completed")) this.reportLiveTasks();
        }
        return;
      }
      case "user.message": {
        this.quellNextWake = false;
        if (this.turn?.localCommand) return;
        if (this.turn?.promptPending) {
          this.turn.promptPending = false;
          if (this.abortWhenStarted) {
            this.abortWhenStarted = false;
            void this.abort();
          }
          return;
        }
        if (this.turn) this.endTurn("success");
        const cause = this.delivering ? "command" : this.steerText !== undefined ? "steer" : "engine";
        if (cause === "steer") this.clearSteer();
        this.delivering = false;
        this.startTurn(cause);
        if (cause !== "engine" && this.abortWhenStarted) {
          this.abortWhenStarted = false;
          void this.abort();
        }
        return;
      }
      case "assistant.turn_start":
        this.ensureTurn();
        return;
      case "assistant.message": {
        this.ensureTurn();
        if (this.quelling) return;
        const content = event.data.content;
        if (content) this.outbox.push({ type: "assistant_text", text: content });
        return;
      }
      case "tool.execution_start":
        this.ensureTurn();
        if (this.quelling) return;
        this.runningTools.add(event.data.toolCallId);
        if (event.data.toolName === QUESTION_TOOL) {
          this.questionCalls.add(event.data.toolCallId);
          const asks = (event.data.arguments as { question?: unknown } | undefined)?.question;
          this.unaskedQuestionCalls.set(event.data.toolCallId, typeof asks === "string" ? asks : undefined);
          return;
        }
        this.outbox.push({
          type: "tool_use",
          toolUseId: event.data.toolCallId,
          name: event.data.toolName,
          input: event.data.arguments,
        });
        const args = event.data.arguments as { command?: unknown; detach?: unknown } | undefined;
        if (args?.detach === true && typeof args.command === "string") {
          this.detachedShellCalls.set(event.data.toolCallId, args.command);
        }
        return;
      case "tool.execution_complete":
        this.runningTools.delete(event.data.toolCallId);
        this.unaskedQuestionCalls.delete(event.data.toolCallId);
        if (this.cutAtToolBoundary && !this.runningTools.size) this.cut();
        // A result straggling in after its Turn ended belongs to no Turn.
        if (!this.turn || this.questionCalls.has(event.data.toolCallId)) return;
        this.outbox.push({
          type: "tool_result",
          toolUseId: event.data.toolCallId,
          text: event.data.result?.content ?? event.data.error?.message,
          isError: !event.data.success,
        });
        return;
      case "assistant.usage":
        if (this.turn) this.turn.usage = addUsage(this.turn.usage, event.data);
        return;
      case "session.usage_info":
        if (event.data.tokenLimit > 0) {
          this.contextPercentage = Math.round((event.data.currentTokens / event.data.tokenLimit) * 100);
        }
        return;
      case "session.error":
        if (this.turn) this.turn.errors.push(event.data.message);
        else console.error("Copilot:", event.data.message);
        return;
      case "session.auto_mode_resolved":
        this.announce(event.data.chosenModel);
        return;
      case "session.model_change":
        if (event.data.newModel === this.switchedTo) {
          this.switchedTo = undefined;
          return;
        }
        // `auto` is resolved per Turn; the model it picks is announced then.
        if (event.data.newModel !== "auto") this.announce(event.data.newModel);
        return;
      case "session.background_tasks_changed":
        this.refreshTasks();
        return;
      case "session.schedule_created": {
        // A schedule wakes the agent on its own until removed, so it is shown
        // as a Background task, which the human can Kill.
        const taskId = scheduleTaskId(event.data.id);
        const description = event.data.displayPrompt ?? event.data.prompt;
        this.liveTasks.set(taskId, { taskType: "schedule", description });
        this.outbox.push({ type: "task_started", taskId, description, taskType: "schedule", ambient: false });
        this.reportLiveTasks();
        return;
      }
      case "session.schedule_cancelled":
        // A one-shot schedule that has fired; one removed by Kill has already settled.
        if (this.settleTask(scheduleTaskId(event.data.id), "completed")) this.reportLiveTasks();
        return;
      case "session.compaction_start":
        // Copilot compacts on its own in the background once the context
        // fills past its threshold; only a `/compact` is manual.
        this.outbox.push({ type: "compacting", trigger: event.data.trigger === "manual" ? "manual" : "auto" });
        return;
      case "session.compaction_complete":
        if (!event.data.success) {
          this.outbox.push({ type: "status", text: `compaction failed${event.data.error ? `: ${event.data.error}` : ""}` });
          return;
        }
        if (this.turn) this.turn.compacted = true;
        this.outbox.push({
          type: "compacted",
          preTokens: event.data.preCompactionTokens,
          postTokens: event.data.postCompactionTokens,
        });
        return;
      case "session.skills_loaded":
      case "commands.changed":
        void this.refreshMenu();
        return;
      case "abort":
        // Cut short for a Steer, the Turn ended the way a Steered one does;
        // anything else that aborts it is a Stop.
        if (this.turn) this.endTurn(this.steerText !== undefined ? "success" : "stopped");
        return;
      case "assistant.idle":
        // A wake-up follows its notification directly; by an idle, any that
        // was coming has come.
        this.quellNextWake = false;
        if (this.turn && !this.turn.localCommand && !this.turn.promptPending) {
          const outcome: TurnOutcome = event.data.aborted
            ? "stopped"
            : this.turn.errors.length
              ? "error"
              : "success";
          this.endTurn(outcome);
        }
        if (!this.turn && this.steerQueued) this.steerDropped();
        return;
    }
  }

  /**
   * Copilot resolves an `auto` model just before the Turn it serves starts.
   * Announced between Turns, it is held until that Turn has started: the
   * Turn a Steer cut short must be followed directly by the Steer's own.
   */
  private announce(model: string | undefined): void {
    if (!model) return;
    if (this.turn) this.outbox.push({ type: "announce", model, permissionMode: PERMISSION_MODE });
    else this.heldAnnouncement = model;
  }

  /**
   * Content with no Turn open means the agent went back to work on its own --
   * unless what woke it was a shell a Stop killed. Copilot reports that shell
   * as completed, and the agent picks the stopped work back up; the human
   * asked for it to stop, so that Turn is aborted before anything of it shows.
   */
  private ensureTurn(): void {
    if (this.turn) return;
    if (this.quellNextWake) {
      this.quellNextWake = false;
      this.quelling = true;
      console.log("Aborting the Turn a stopped Background task woke the agent into.");
      void this.abort();
      return;
    }
    this.startTurn("engine");
  }

  private startTurn(cause: "command" | "steer" | "engine"): void {
    this.turn = { startedAt: Date.now(), usage: undefined, errors: [] };
    this.outbox.push({ type: "turn_started", cause });
    const held = this.heldAnnouncement;
    this.heldAnnouncement = undefined;
    this.announce(held);
  }

  private endTurn(outcome: TurnOutcome): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    this.runningTools.clear();
    this.unaskedQuestionCalls.clear();
    // With no Turn left to cut, a queued Steer simply runs next.
    this.cutAtToolBoundary = false;
    this.outbox.push({
      type: "turn_ended",
      outcome,
      durationMs: Date.now() - turn.startedAt,
      ...(turn.errors.length ? { errors: turn.errors } : {}),
      ...(turn.usage ? { usage: turn.usage } : {}),
      ...(outcome === "success" && this.contextPercentage !== undefined
        ? { contextPercentage: this.contextPercentage }
        : {}),
    });
    for (const unrun of this.unrunAfterTurn.splice(0)) this.reportUnrun(unrun);
    this.deliverNext();
  }

  /** A Turn for a Command or Steer that never ran, so whoever sent it hears how it ended. */
  private reportUnrun({ cause, outcome, errors }: Unrun): void {
    this.outbox.push({ type: "turn_started", cause });
    this.outbox.push({ type: "turn_ended", outcome, durationMs: 0, ...(errors ? { errors } : {}) });
  }

  private runtimeGone(): void {
    if (this.closed || this.dead) return;
    this.dead = true;
    console.error("The Copilot runtime exited.");
    if (this.turn) {
      this.turn.errors.push(RUNTIME_GONE);
      this.endTurn("error");
    }
    const gone = (cause: Unrun["cause"]): Unrun => ({ cause, outcome: "error", errors: [RUNTIME_GONE] });
    if (this.steerText !== undefined) {
      this.clearSteer();
      this.reportUnrun(gone("steer"));
    }
    if (this.delivering) {
      this.delivering = false;
      this.reportUnrun(gone("command"));
    }
    for (const _ of this.waiting.splice(0)) this.reportUnrun(gone("command"));
  }

  /**
   * Copilot's change notification carries nothing, so the live set is re-read
   * on each one. Bursts of notifications collapse into one read, plus one more
   * if any arrived while it ran.
   */
  private refreshTasks(): void {
    if (this.refreshingTasks) {
      this.tasksStale = true;
      return;
    }
    this.refreshingTasks = (async () => {
      do {
        this.tasksStale = false;
        try {
          this.applyTasks(await this.session.listTasks());
        } catch (e) {
          console.error("Failed to list Copilot tasks:", (e as Error).message);
        }
      } while (this.tasksStale && !this.closed);
      this.refreshingTasks = undefined;
    })();
  }

  private applyTasks(tasks: CopilotTask[]): void {
    if (this.closed) return;
    let changed = false;
    const listed = new Set(tasks.map((t) => t.id));
    for (const task of tasks.filter(isBackgroundTask)) {
      if (isRunning(task) && !this.seenTasks.has(task.id)) {
        this.seenTasks.add(task.id);
        const live: LiveTask = { taskType: task.type, description: task.description, toolUseId: this.startedBy(task) };
        this.liveTasks.set(task.id, live);
        this.outbox.push({
          type: "task_started",
          taskId: task.id,
          ...(live.toolUseId ? { toolUseId: live.toolUseId } : {}),
          description: task.description,
          taskType: task.type,
          ambient: false,
        });
        changed = true;
      } else if (!isRunning(task)) {
        const status = task.status === "cancelled" ? "stopped" : task.status === "failed" ? "failed" : "completed";
        changed = this.settleTask(task.id, status) || changed;
        // An idle agent can be woken by a follow-up message, running again
        // under the same id, so it may be reported again.
        if (task.status === "idle") this.seenTasks.delete(task.id);
      }
    }
    // Copilot keeps a finished Background task listed; one that has gone
    // from the list altogether is over all the same.
    for (const taskId of [...this.liveTasks.keys()]) {
      if (!listed.has(taskId)) changed = this.settleTask(taskId, "completed") || changed;
    }
    if (changed) this.reportLiveTasks();
  }

  /** The tool call that started `task`: an agent names it; a shell is matched to the call that ran its command. */
  private startedBy(task: CopilotTask): string | undefined {
    if (task.toolCallId) return task.toolCallId;
    if (task.type !== "shell" || task.command === undefined) return undefined;
    for (const [toolCallId, command] of this.detachedShellCalls) {
      if (command !== task.command) continue;
      this.detachedShellCalls.delete(toolCallId);
      return toolCallId;
    }
    return undefined;
  }

  /** Reports a live Background task settled. Returns false, reporting nothing, if it wasn't live. */
  private settleTask(taskId: string, status: "completed" | "failed" | "stopped"): boolean {
    const task = this.liveTasks.get(taskId);
    if (!task) return false;
    this.liveTasks.delete(taskId);
    this.outbox.push({
      type: "task_settled",
      taskId,
      ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}),
      status,
      ambient: false,
    });
    return true;
  }

  /** Reports the whole live set, which replaces whatever the tray showed. */
  private reportLiveTasks(): void {
    this.outbox.push({
      type: "tasks_changed",
      tasks: [...this.liveTasks].map(([taskId, t]) => ({ taskId, taskType: t.taskType, description: t.description })),
    });
  }
}

/** Copilot's refusal, without the RPC wrapping around it. */
function copilotMessage(e: unknown): string {
  return (e as Error).message.replace(/^Request [\w.]+ failed with message: /, "");
}

/** Where Claude Code keeps a developer's personal Skills, written for Claude rather than Copilot. */
const CLAUDE_PERSONAL_SKILLS = join(homedir(), ".claude", "skills") + sep;

/**
 * A Skill the human can invoke, from anywhere but the developer's personal
 * Claude Skills. Copilot doesn't load those today (measured on CLI 1.0.88);
 * this keeps them off the menu should a later version start to.
 */
function isMenuSkill(skill: CopilotSkill): boolean {
  return skill.userInvocable && skill.enabled && !skill.path?.startsWith(CLAUDE_PERSONAL_SKILLS);
}

function skillInfo(skill: CopilotSkill): SkillInfo {
  return { name: skill.commandName ?? skill.name, description: skill.description, argumentHint: skill.argumentHint ?? "" };
}

/**
 * The Local commands to offer: Copilot's built-ins and the connector's own,
 * one of each name. Of the connector's, `/clear` is registered with Copilot
 * and runs through it, so should Copilot come to list a built-in `/clear`,
 * the built-in takes its place here; which of the two runs is Copilot's to
 * decide, since a command is invoked by name. Copilot lists no `/clear` to
 * SDK clients today (measured on CLI 1.0.88); its terminal's abandons the
 * session for a new one, and if one reached SDK clients and did the same, the
 * connector would have to follow the new session id as the same
 * Conversation. The ones the connector runs itself always win.
 */
function menuCommands(commands: CopilotCommand[]): CopilotCommand[] {
  const builtins = new Set(commands.filter((c) => c.kind === "builtin").map((c) => c.name.toLowerCase()));
  return commands.filter(
    (c) =>
      c.kind === "builtin" ||
      c.kind === CONNECTOR_KIND ||
      (c.kind === "client" && !builtins.has(c.name.toLowerCase())),
  );
}

/** The kind of the Local commands the connector runs itself, without calling Copilot. */
const CONNECTOR_KIND = "connector";

/** A Local command the connector runs itself, resolving with the status line it ends on. */
type OwnCommand = CopilotCommand & { run: (deps: ModelPickerDeps, input?: string) => Promise<string> };

/**
 * The Local commands the connector runs itself. Copilot's own `/model`
 * checks the model it is given and then switches nothing for an SDK client,
 * with a model named or without (measured on CLI 1.0.88), and Copilot has no
 * `/effort` at all, so typed it reaches the model as a prompt.
 */
const OWN_COMMANDS: OwnCommand[] = [
  {
    name: "model",
    aliases: ["models"],
    description: "Choose the model and its effort",
    kind: CONNECTOR_KIND,
    input: { hint: "[model] [effort]" },
    run: chooseModel,
  },
  {
    name: "effort",
    description: "Choose the model's effort",
    kind: CONNECTOR_KIND,
    input: { hint: "[level]" },
    run: chooseEffort,
  },
];

function commandNames(command: CopilotCommand): string[] {
  return [command.name, ...(command.aliases ?? [])].map((name) => name.toLowerCase());
}

/** Copilot's commands with the connector's own in place of any Copilot lists under one of their names. */
function withOwnCommands(commands: CopilotCommand[]): CopilotCommand[] {
  const claimed = new Set(OWN_COMMANDS.flatMap(commandNames));
  return [...commands.filter((c) => !commandNames(c).some((n) => claimed.has(n))), ...OWN_COMMANDS];
}

/** Every command by lower-cased name and alias, as a Command is looked up. */
function commandsByName(commands: CopilotCommand[]): Map<string, CopilotCommand> {
  return new Map(commands.flatMap((c) => commandNames(c).map((name) => [name, c] as const)));
}

function commandInfo(command: CopilotCommand): SkillInfo {
  return { name: command.name, description: command.description, argumentHint: command.input?.hint ?? "" };
}

/** Copilot numbers schedules apart from its tasks, so the Background task for one is named apart too. */
function scheduleTaskId(id: number): string {
  return `schedule-${id}`;
}

function scheduleIdOf(taskId: string): number {
  return Number(taskId.slice("schedule-".length));
}

/** Copilot lists foreground shells as tasks too; only work that runs on its own is a Background task. */
function isBackgroundTask(task: CopilotTask): boolean {
  if (task.type === "shell") return task.attachmentMode === "detached";
  return task.executionMode !== "sync";
}

/**
 * An agent that has done its work goes idle, open to follow-up messages, and
 * Copilot never goes on to list it completed (measured on CLI 1.0.88), so an
 * idle agent has finished.
 */
function isRunning(task: CopilotTask): boolean {
  return task.status === "running" || (task.status === "idle" && task.type !== "agent");
}

/**
 * Adds one model call's tokens to a Turn's. Copilot's input count includes
 * the cached tokens it also reports separately; the neutral input count is
 * uncached input only, as on Claude, so they are taken out. Copilot's own
 * session totals are computed the same way.
 */
function addUsage(
  sum: EngineUsage | undefined,
  call: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number },
): EngineUsage {
  const cacheRead = call.cacheReadTokens ?? 0;
  const cacheWrite = call.cacheWriteTokens ?? 0;
  return {
    inputTokens: (sum?.inputTokens ?? 0) + Math.max(0, (call.inputTokens ?? 0) - cacheRead - cacheWrite),
    outputTokens: (sum?.outputTokens ?? 0) + (call.outputTokens ?? 0),
    cacheReadTokens: (sum?.cacheReadTokens ?? 0) + cacheRead,
    cacheWriteTokens: (sum?.cacheWriteTokens ?? 0) + cacheWrite,
  };
}

/**
 * The Copilot adapter: everything the Engine seam hides about the Copilot
 * SDK -- its runtime and login, its session events, how a Turn starts and
 * ends, Stop, and resume.
 */
export class CopilotEngine implements Engine {
  readonly kind = "copilot" as const;
  readonly capabilities = { steer: true };
  private runtime: Promise<CopilotRuntime> | undefined;

  constructor(private readonly deps: CopilotEngineDeps) {}

  private startRuntime(): Promise<CopilotRuntime> {
    this.runtime ??= this.deps.startRuntime();
    return this.runtime;
  }

  async verify(): Promise<void> {
    const runtime = await this.startRuntime();
    const status = await runtime.authStatus();
    if (!status.isAuthenticated) {
      await this.stopRuntime(runtime);
      // Copilot's own message can be as bare as "Not authenticated".
      throw new Error(
        `Copilot isn't signed in${status.statusMessage ? ` (${status.statusMessage})` : ""}. ` +
          "Run `copilot login`, or set COPILOT_GITHUB_TOKEN.",
      );
    }
  }

  async open(options: OpenOptions): Promise<EngineSession> {
    const runtime = await this.startRuntime();
    try {
      return await this.openOn(runtime, options);
    } catch (e) {
      await this.stopRuntime(runtime);
      throw e;
    }
  }

  /** Leaves no runtime process behind a startup that failed. */
  private async stopRuntime(runtime: CopilotRuntime): Promise<void> {
    this.runtime = undefined;
    await runtime.stop().catch(() => undefined);
  }

  private async openOn(runtime: CopilotRuntime, options: OpenOptions): Promise<EngineSession> {
    // Copilot takes the question handler when the session is made, before
    // there is an Engine session to answer it; it only asks inside a Turn,
    // by which time there is.
    let engineSession: CopilotEngineSession | undefined;
    const sessionOptions: CopilotSessionOptions = {
      model: this.deps.model,
      workingDirectory: options.projectDir,
      onPermissionRequest: approveEverything,
      onUserInputRequest: (request) =>
        engineSession ? engineSession.ask(request) : Promise.reject(new Error("the session isn't open yet")),
      ...(options.onShowImage ? { tools: [showImageTool(options.onShowImage)] } : {}),
    };
    // The menu is read before the session is handed over, so the first
    // Command can already be told apart from a Local command.
    const wrap = async (session: CopilotSessionHandle, conversation: Extract<EngineEvent, { type: "conversation" }>) => {
      engineSession = new CopilotEngineSession(runtime, session, options, conversation);
      await engineSession.refreshMenu();
      return engineSession;
    };

    if (options.resume) {
      try {
        const session = await runtime.resumeSession(options.resume, sessionOptions);
        return await wrap(session, { type: "conversation", id: session.sessionId, resumed: true });
      } catch (e) {
        // A Conversation that can't be reopened is never a reason to fail:
        // start fresh and say so. Anything that stops a fresh session too --
        // auth, licence, policy -- fails below, with Copilot's own message.
        console.log(`Couldn't resume Copilot conversation ${options.resume}: ${(e as Error).message}`);
        const session = await runtime.createSession(sessionOptions);
        return wrap(session, { type: "conversation", id: session.sessionId, resumed: false, lostPrevious: true });
      }
    }
    const session = await runtime.createSession(sessionOptions);
    return wrap(session, { type: "conversation", id: session.sessionId, resumed: false });
  }
}
