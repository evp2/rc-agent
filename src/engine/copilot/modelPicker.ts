import type { EngineQuestion } from "../types";
import type { CopilotModel, CopilotModelChoice } from "./runtime";

type QuestionItem = EngineQuestion["questions"][number];

/** What choosing a model needs from the session it is chosen for. */
export interface ModelPickerDeps {
  /** The models Copilot offers the account. */
  listModels(): Promise<CopilotModel[]>;
  current(): Promise<Partial<CopilotModelChoice>>;
  switchTo(choice: CopilotModelChoice): Promise<void>;
  /** Puts one question to the human; resolves with the option picked, or the text typed instead. */
  ask(question: QuestionItem): Promise<string>;
}

/**
 * `/model`: with nothing after it, asks which model to use and then, when
 * the model takes a choice of effort levels, which one; with a model named,
 * and optionally an effort after it, switches straight away. Resolves with
 * the status line saying what the session is on now; rejects, switching
 * nothing, with the reason it couldn't.
 */
export async function chooseModel(deps: ModelPickerDeps, input?: string): Promise<string> {
  const [models, current] = await Promise.all([offered(deps), deps.current()]);
  const typed = input?.trim();
  let model: CopilotModel;
  let effort: string | undefined;
  if (typed) {
    ({ model, effort } = parseModelInput(models, typed));
  } else {
    model = findModel(models, await deps.ask(modelQuestion(models, current)));
    if (model.efforts.length > 1) effort = findEffort(model, await deps.ask(effortQuestion(model, current)));
  }
  const reasoningEffort = effort ?? carriedEffort(model, current);
  const choice = { modelId: model.id, ...(reasoningEffort ? { reasoningEffort } : {}) };
  await deps.switchTo(choice);
  return `model set to ${model.name}${choice.reasoningEffort ? ` · effort ${choice.reasoningEffort}` : ""}`;
}

/**
 * `/effort`: with nothing after it, asks which of the current model's effort
 * levels to use; with a level named, sets it straight away. The model stays
 * as it is.
 */
export async function chooseEffort(deps: ModelPickerDeps, input?: string): Promise<string> {
  // Every model, not only those offered: the session can be on one the
  // account's policy wouldn't let it pick now.
  const [models, current] = await Promise.all([deps.listModels(), deps.current()]);
  const model = models.find((m) => m.id === current.modelId);
  if (!model) throw new Error(`Copilot doesn't list the model this session is on (${current.modelId ?? "none"})`);
  if (!model.efforts.length) throw new Error(noEffortLevels(model));
  const typed = input?.trim();
  const effort = findEffort(model, typed || (await deps.ask(effortQuestion(model, current))));
  await deps.switchTo({ modelId: model.id, reasoningEffort: effort });
  return `effort set to ${effort}`;
}

/** The models the account's policy lets it pick, in Copilot's order. */
async function offered(deps: ModelPickerDeps): Promise<CopilotModel[]> {
  return (await deps.listModels()).filter((m) => m.enabled);
}

/**
 * A model named on its own, or followed by one of its effort levels. A
 * display name can have spaces in it, so the whole input is tried as a
 * model before its last word is taken for an effort.
 */
function parseModelInput(models: CopilotModel[], input: string): { model: CopilotModel; effort?: string } {
  const whole = matchModel(models, input);
  if (whole) return { model: whole };
  const split = /^(.*\S)\s+(\S+)$/.exec(input);
  if (!split) throw new Error(noModelCalled(input, models));
  const model = findModel(models, split[1]);
  return { model, effort: findEffort(model, split[2]) };
}

function findModel(models: CopilotModel[], text: string): CopilotModel {
  const model = matchModel(models, text);
  if (!model) throw new Error(noModelCalled(text, models));
  return model;
}

/**
 * The model `text` names: by its id or display name, ignoring case, or else
 * the only one whose id or name contains it, so `opus 5.5` finds
 * `claude-opus-5.5`.
 */
function matchModel(models: CopilotModel[], text: string): CopilotModel | undefined {
  const wanted = normalize(text);
  if (!wanted) return undefined;
  const exact = models.find((m) => normalize(m.id) === wanted || normalize(m.name) === wanted);
  if (exact) return exact;
  const partial = models.filter((m) => normalize(m.id).includes(wanted) || normalize(m.name).includes(wanted));
  return partial.length === 1 ? partial[0] : undefined;
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[\s_-]+/g, "-");
}

function noModelCalled(text: string, models: CopilotModel[]): string {
  return `no model called "${text.trim()}"; this account can use ${models.map((m) => m.id).join(", ")}`;
}

function modelQuestion(models: CopilotModel[], current: Partial<CopilotModelChoice>): QuestionItem {
  return {
    question: "Which model should this session use?",
    header: "Model",
    options: models.map((m) => ({
      label: m.name,
      description: [m.id, m.multiplier !== undefined ? `${m.multiplier}×` : undefined, m.id === current.modelId ? "current" : undefined]
        .filter(Boolean)
        .join(" · "),
    })),
    multiSelect: false,
  };
}

function effortQuestion(model: CopilotModel, current: Partial<CopilotModelChoice>): QuestionItem {
  return {
    question: `Which effort should ${model.name} use?`,
    header: "Effort",
    options: model.efforts.map((level) => {
      const marks = [
        level === model.defaultEffort ? "default" : undefined,
        model.id === current.modelId && level === current.reasoningEffort ? "current" : undefined,
      ].filter(Boolean);
      return { label: level, ...(marks.length ? { description: marks.join(" · ") } : {}) };
    }),
    multiSelect: false,
  };
}

function findEffort(model: CopilotModel, text: string): string {
  const level = model.efforts.find((e) => e.toLowerCase() === text.trim().toLowerCase());
  if (level) return level;
  throw new Error(
    model.efforts.length
      ? `${model.name} takes effort ${model.efforts.join(", ")}, not "${text.trim()}"`
      : noEffortLevels(model),
  );
}

function noEffortLevels(model: CopilotModel): string {
  return `${model.name} has no effort levels to choose from`;
}

/**
 * The effort a model switched to without one named: the session's current
 * one if the model takes it, else the model's default. A model with no
 * levels gets none -- Copilot refuses a session asking a model for an effort
 * it doesn't take.
 */
function carriedEffort(model: CopilotModel, current: Partial<CopilotModelChoice>): string | undefined {
  if (current.reasoningEffort && model.efforts.includes(current.reasoningEffort)) return current.reasoningEffort;
  return model.defaultEffort && model.efforts.includes(model.defaultEffort) ? model.defaultEffort : undefined;
}
