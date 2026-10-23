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

export function connectorTools(options: OpenOptions): ToolDefinition[] {
  return [
    questionTool(options.onQuestion),
    ...(options.onShowImage ? [showImageTool(options.onShowImage)] : []),
    ...(options.onArchiveFile ? [archiveFileTool(options.onArchiveFile)] : []),
  ];
}
