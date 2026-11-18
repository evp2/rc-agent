import type {
  EngineDispatch,
  EngineSibling,
  ListSiblingsOutcome,
  OpenOptions,
  SendDispatchOutcome,
} from "./types";

export const LIST_SIBLINGS_DESCRIPTION =
  "List the other sessions you can hand work to: sessions started under the same credential as this one that are still running. " +
  "Each has an id, the project directory it works in, its Engine and a name. Call this to find the id to pass to send_dispatch.";

export const SEND_DISPATCH_DESCRIPTION =
  "Send an instruction, as plain text, to one other session by id. It is held until a human at that session " +
  "promotes it; nothing happens there before then, and no reply or result ever comes back to you. A Turn that a " +
  "Dispatch started cannot send another. Say everything the other session needs: it cannot see this conversation.";

export const SEND_DISPATCH_TO_DESCRIPTION = "The id of the other session, from list_siblings.";

export const SEND_DISPATCH_TEXT_DESCRIPTION = "The instruction, as plain text.";

export const DISPATCH_HELD =
  "The Dispatch is held. A human at that session decides whether to promote it, and no reply will come back to you.";

export function siblingsText(siblings: EngineSibling[]): string {
  if (siblings.length === 0) return "There are no other sessions you can reach right now.";
  return JSON.stringify(
    {
      siblings: siblings.map((s) => ({
        session_id: s.sessionId,
        project_dir: s.projectDir,
        engine: s.engine,
        name: s.name,
      })),
    },
    null,
    2,
  );
}

export function dispatchRefusalText(reason: string, relayMessage: string): string {
  switch (reason) {
    case "no_such_sibling":
      return "The Dispatch was refused: there is no other session with that id under this credential. Call list_siblings for the ids you can reach.";
    case "target_ended":
      return "The Dispatch was refused: that session has ended, so nothing can be handed to it.";
    case "text_too_long":
      return `The Dispatch was refused: the text is too long. Shorten it and send it again. (${relayMessage})`;
    case "too_many_held":
      return "The Dispatch was refused: that session already has too many Dispatches waiting for a human. Do not retry now.";
    case "from_dispatch_turn":
      return "The Dispatch was refused: this Turn was itself started by a Dispatch, and a Dispatch-started Turn cannot send another. Report what you found in your reply instead.";
    default:
      return `The Dispatch was refused: ${relayMessage}`;
  }
}

export async function forwardListSiblings(
  onListSiblings: NonNullable<OpenOptions["onListSiblings"]>,
  signal: AbortSignal,
): Promise<ListSiblingsOutcome> {
  try {
    return await onListSiblings(signal);
  } catch (e) {
    return { reason: (e as Error).message };
  }
}

export async function forwardSendDispatch(
  onSendDispatch: NonNullable<OpenOptions["onSendDispatch"]>,
  dispatch: EngineDispatch,
  signal: AbortSignal,
): Promise<SendDispatchOutcome> {
  try {
    return await onSendDispatch(dispatch, signal);
  } catch (e) {
    return { sent: false, reason: (e as Error).message };
  }
}
