import type { EngineForget, EngineMemory, ForgetOutcome, OpenOptions, RememberOutcome, RememberScope } from "./types";

export const REMEMBER_DESCRIPTION =
  "Save a Memory: a short note that every later Session on this machine is told about at its start. " +
  "Use it only when the human asks you to remember something, and call it before you tell them it is " +
  "remembered. A Memory saved under an existing name replaces the old one. Never save a credential or secret.";

export const REMEMBER_SCOPES = ["global", "project"] as const;
export const REMEMBER_SCOPE_DESCRIPTION =
  "global for something true on every project (the person's habits and preferences); " +
  "project for something about this repository only, which every worktree of it shares.";

export function isRememberScope(value: unknown): value is RememberScope {
  return REMEMBER_SCOPES.includes(value as never);
}

export const REMEMBER_NAME_DESCRIPTION = "A short name in lowercase letters, digits and hyphens, for example commit-style.";
export const REMEMBER_DESCRIPTION_DESCRIPTION = "One line saying what the Memory is about, so a later Session can tell whether to open it.";
export const REMEMBER_CONTENT_DESCRIPTION = "The note itself.";

export const FORGET_DESCRIPTION =
  "Forget a Memory so later Sessions are no longer told about it. Use it only when the human asks you to " +
  "forget something, and call it before you tell them it is forgotten. The file is kept aside, not destroyed.";

export const FORGET_NAME_DESCRIPTION = "The name of the Memory to forget, as listed in the memories of that scope.";

export function credentialRefusalText(): string {
  return (
    "Not saved: that looks like a credential, and Memories are plain files that every later Session reads. " +
    "Save the non-secret part instead, such as which profile, file or vault holds the credential."
  );
}

export function memoryTooLargeText(maxBytes: number): string {
  return `Not saved: that Memory is over the ${maxBytes}-byte limit. Shorten it, or split it into several smaller Memories.`;
}

export function descriptionTooLargeText(maxBytes: number): string {
  return `Not saved: that description is over the ${maxBytes}-byte limit. Shorten it to one brief line.`;
}

export function indexFullText(maxLines: number): string {
  return `Not saved: the index already holds ${maxLines} Memories, its limit. Forget one you no longer need, or merge related ones, then try again.`;
}

export function memoryFolderUnavailableText(): string {
  return "Not saved: the memory folder can't be written to right now. Nothing was remembered; tell the human, and carry on without it.";
}

/** The tool's whole result when the Memory was saved. */
export function rememberedText(scope: RememberScope, index: string, replaced = false): string {
  const lead = replaced ? "Saved, replacing the Memory that had this name." : "Saved.";
  return `${lead} The ${scope === "global" ? "Global" : "Project"} memories are now:\n${index}\nIf one of these contradicts what you just saved, save again under its name to reconcile them.`;
}

export function forgetUnknownText(name: string): string {
  return `Nothing forgotten: there is no Memory named "${name}". Nothing was changed.`;
}

/** The tool's whole result when the Memory was forgotten. */
export function forgottenText(scope: RememberScope, index: string): string {
  return `Forgotten. The ${scope === "global" ? "Global" : "Project"} memories are now:\n${index || "(none)"}`;
}

/** What the model is told at the start of a Session, ahead of the indexes of the Memories that exist. */
export function memoryStartupText(
  indexes: { global: string; project: string },
  folders: { global: string; project: string },
): string {
  const intro =
    "Memories are short notes kept across Sessions, in two scopes: Global (every project) and Project (this repository only). " +
    "Save one with the `remember` tool only when the human asks you to remember something, and save it before you say it is remembered. " +
    "Likewise use `forget` only when asked to forget one. " +
    "Open a Memory only when its description looks relevant; each is a file named <name>.md in its scope's folder.";
  const section = (label: string, index: string, folder: string) =>
    index ? `${label} memories (${folder}):\n${index}` : `There are no ${label} memories yet.`;
  return `${intro}\n\n${section("Global", indexes.global, folders.global)}\n\n${section("Project", indexes.project, folders.project)}`;
}

export function rememberScopeInvalidText(): string {
  return "the memory couldn't be saved: the scope must be global or project";
}

export function rememberFieldsMissingText(): string {
  return "the memory couldn't be saved: a name, description and content are all needed";
}

export function forgetScopeInvalidText(): string {
  return "nothing was forgotten: the scope must be global or project";
}

export function forgetNameMissingText(): string {
  return "nothing was forgotten: a name is needed";
}

async function forward<Call, Outcome>(
  callback: (call: Call, signal: AbortSignal) => Promise<Outcome>,
  call: Call,
  signal: AbortSignal,
  failed: (reason: string) => Outcome,
): Promise<Outcome> {
  try {
    return await callback(call, signal);
  } catch (e) {
    return failed((e as Error).message);
  }
}

/** Hands one call to `onRemember`. A throw is a failure like any other, its message the reason. */
export function forwardRemember(
  onRemember: NonNullable<OpenOptions["onRemember"]>,
  memory: EngineMemory,
  signal: AbortSignal,
): Promise<RememberOutcome> {
  return forward(onRemember, memory, signal, (reason) => ({ saved: false, reason }));
}

/** Like {@link forwardRemember}, for `onForget`. */
export function forwardForget(
  onForget: NonNullable<OpenOptions["onForget"]>,
  forget: EngineForget,
  signal: AbortSignal,
): Promise<ForgetOutcome> {
  return forward(onForget, forget, signal, (reason) => ({ forgotten: false, reason }));
}
