import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import { ARCHIVE_FILE_DESCRIPTION, ARCHIVE_FILE_PATH_DESCRIPTION, archivedText, forwardArchiveFile } from "../archiveFileTool";
import {
  forwardShowImage,
  IMAGE_SHOWN,
  SHOW_IMAGE_CAPTION_DESCRIPTION,
  SHOW_IMAGE_DESCRIPTION,
  SHOW_IMAGE_PATH_DESCRIPTION,
} from "../showImageTool";
import type { EngineAnswer, EngineQuestion, OpenOptions } from "../types";
import type { TaskRegistry } from "./backgroundTasks";

export const QUESTION_TOOL = "ask_user_question";

const QUESTION_DESCRIPTION =
  "Ask the human one or more multiple-choice questions and wait for their answers. They answer on their phone. " +
  "Use it when you need a decision or a preference from them before you can go on. Each question offers a few " +
  "options; the human may also answer in their own words.";

const QuestionParameters = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({ description: "The full question to ask." }),
      header: Type.Optional(Type.String({ description: "A very short label for the question." })),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "The option as the human will pick it." }),
          description: Type.Optional(Type.String({ description: "What picking this option means." })),
        }),
        { minItems: 1 },
      ),
      multiSelect: Type.Boolean({ description: "Whether the human may pick more than one option." }),
    }),
    { minItems: 1 },
  ),
});

function text(value: string, isError = false) {
  return { content: [{ type: "text" as const, text: value }], details: undefined, ...(isError ? { isError } : {}) };
}

function answerText(questions: EngineQuestion["questions"], answer: EngineAnswer): string {
  const lines = questions.map(({ question }) => `"${question}" = "${answer.answers[question] ?? ""}"`);
  const response = answer.response?.trim();
  if (response) lines.push(`They also said: ${response}`);
  return `The human answered:\n${lines.join("\n")}`;
}

function questionTool(onQuestion: OpenOptions["onQuestion"]): ToolDefinition {
  return defineTool({
    name: QUESTION_TOOL,
    label: "Ask the human",
    description: QUESTION_DESCRIPTION,
    parameters: QuestionParameters,
    // Pi otherwise runs a batch at once, and the human is asked one Question at a time.
    executionMode: "sequential",
    execute: async (toolCallId, { questions }, signal) => {
      const answer = await onQuestion({ toolUseId: toolCallId, questions }, signal ?? new AbortController().signal);
      return text(answerText(questions, answer));
    },
  });
}

function showImageTool(onShowImage: NonNullable<OpenOptions["onShowImage"]>): ToolDefinition {
  return defineTool({
    name: "show_image",
    label: "Show image",
    description: SHOW_IMAGE_DESCRIPTION,
    parameters: Type.Object({
      path: Type.String({ description: SHOW_IMAGE_PATH_DESCRIPTION }),
      caption: Type.Optional(Type.String({ description: SHOW_IMAGE_CAPTION_DESCRIPTION })),
    }),
    execute: async (toolCallId, { path, caption }, signal) => {
      const outcome = await forwardShowImage(
        onShowImage,
        { toolUseId: toolCallId, path, ...(caption ? { caption } : {}) },
        signal ?? new AbortController().signal,
      );
      return outcome.shown ? text(IMAGE_SHOWN) : text(outcome.reason, true);
    },
  });
}

function archiveFileTool(onArchiveFile: NonNullable<OpenOptions["onArchiveFile"]>): ToolDefinition {
  return defineTool({
    name: "archive_file",
    label: "Archive file",
    description: ARCHIVE_FILE_DESCRIPTION,
    parameters: Type.Object({ path: Type.String({ description: ARCHIVE_FILE_PATH_DESCRIPTION }) }),
    execute: async (toolCallId, { path }, signal) => {
      const outcome = await forwardArchiveFile(
        onArchiveFile,
        { toolUseId: toolCallId, path },
        signal ?? new AbortController().signal,
      );
      return outcome.archived
        ? text(archivedText(outcome.filename, outcome.byteLength))
        : text(outcome.reason, true);
    },
  });
}

const BASH_BACKGROUND_DESCRIPTION =
  "Run a shell command in the background and return at once with a task id. Use it for a dev server, a long " +
  "build or any command you do not need to wait for. The command keeps running after this turn ends; when it " +
  "exits you are woken with its exit status and the last of its output. At most four background tasks run at a time.";

function bashBackgroundTool(tasks: TaskRegistry): ToolDefinition {
  return defineTool({
    name: "bash_background",
    label: "Background shell",
    description: BASH_BACKGROUND_DESCRIPTION,
    parameters: Type.Object({
      command: Type.String({ description: "The shell command to run." }),
      description: Type.Optional(Type.String({ description: "A few words saying what the command is for." })),
    }),
    execute: async (toolCallId, { command, description }) => {
      const started = tasks.startShell(toolCallId, command, description);
      if (!started.ok) return text(started.reason, true);
      return text(`Started background task ${started.taskId}. You will be woken with the result when it finishes.`);
    },
  });
}

const SUBAGENT_DESCRIPTION =
  "Hand a self-contained job to a subagent: a separate agent with its own context that works in the same project " +
  "and has the file and shell tools, but cannot ask the human questions. Give it everything it needs in the prompt, " +
  "since it sees nothing of this conversation. By default the call waits and returns the subagent's final answer. " +
  "With background true it returns a task id at once, runs while you carry on, and wakes you with its answer when " +
  "it finishes. At most four background tasks run at a time.";

function subagentTool(tasks: TaskRegistry): ToolDefinition {
  return defineTool({
    name: "subagent",
    label: "Subagent",
    description: SUBAGENT_DESCRIPTION,
    parameters: Type.Object({
      prompt: Type.String({ description: "The full instructions for the subagent." }),
      description: Type.String({ description: "A few words saying what the subagent is for." }),
      background: Type.Optional(
        Type.Boolean({ description: "Return a task id at once instead of waiting for the answer. Defaults to false." }),
      ),
    }),
    execute: async (toolCallId, { prompt, description, background }) => {
      const started = tasks.startSubagent(toolCallId, prompt, description, !background);
      if (!started.ok) return text(started.reason, true);
      if (background) return text(`Started background task ${started.taskId}. You will be woken with the result when it finishes.`);
      const done = await started.finished;
      return done.status === "completed"
        ? text(done.summary)
        : text(`Subagent ${done.taskId} ${done.status}: ${done.summary}`, true);
    },
  });
}

export function connectorTools(options: OpenOptions, tasks: TaskRegistry): ToolDefinition[] {
  return [
    questionTool(options.onQuestion),
    bashBackgroundTool(tasks),
    subagentTool(tasks),
    ...(options.onShowImage ? [showImageTool(options.onShowImage)] : []),
    ...(options.onArchiveFile ? [archiveFileTool(options.onArchiveFile)] : []),
  ];
}
