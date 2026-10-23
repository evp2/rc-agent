import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import type { EngineQuestion } from "../types";

type PiModel = NonNullable<AgentSession["model"]>;
type QuestionItem = EngineQuestion["questions"][number];

export interface ModelCommandDeps {
  session: AgentSession;
  piProvider: string;
  ask(question: QuestionItem): Promise<string>;
}

export interface ModelSwitched {
  status: string;
  modelChanged: boolean;
}

export async function chooseModel(
  deps: ModelCommandDeps,
  input: string | undefined,
): Promise<ModelSwitched> {
  const { session } = deps;
  const models = await offered(deps);
  const typed = input?.trim();
  let model: PiModel;
  let effort: string | undefined;
  if (typed) {
    try {
      ({ model, effort } = parseModelInput(models, typed));
    } catch (e) {
      throw (await elsewhere(deps, typed)) ?? e;
    }
  } else {
    model = findModel(
      models,
      await deps.ask(modelQuestion(models, session.model)),
    );
    if (levelsOf(model).length > 1)
      effort = findEffort(
        model,
        await deps.ask(effortQuestion(model, session)),
      );
  }
  await session.setModel(model);
  if (effort)
    session.setThinkingLevel(
      effort as Parameters<AgentSession["setThinkingLevel"]>[0],
    );
  const level = levelsOf(model).length > 1 ? session.thinkingLevel : undefined;
  return {
    status: `model set to ${model.id}${level ? ` · effort ${level}` : ""}`,
    modelChanged: true,
  };
}

export async function chooseEffort(
  deps: ModelCommandDeps,
  input: string | undefined,
): Promise<ModelSwitched> {
  const { session } = deps;
  const model = session.model;
  if (!model || levelsOf(model).length < 2) {
    throw new Error(
      `${model?.id ?? "this session's model"} has no effort levels to choose from`,
    );
  }
  const typed = input?.trim();
  const effort = findEffort(
    model,
    typed || (await deps.ask(effortQuestion(model, session))),
  );
  session.setThinkingLevel(
    effort as Parameters<AgentSession["setThinkingLevel"]>[0],
  );
  return { status: `effort set to ${effort}`, modelChanged: false };
}

async function offered(deps: ModelCommandDeps): Promise<PiModel[]> {
  return [...(await deps.session.modelRuntime.getAvailable(deps.piProvider))];
}

async function elsewhere(
  deps: ModelCommandDeps,
  typed: string,
): Promise<Error | undefined> {
  const all = await deps.session.modelRuntime.getAvailable();
  const others = all.filter((m) => m.provider !== deps.piProvider);
  const words = /^(.*\S)\s+\S+$/.exec(typed);
  const hit = matchModel(others, typed) ?? (words && matchModel(others, words[1]));
  if (!hit) return undefined;
  return new Error(
    `${hit.id} is on another provider (${hit.provider}); this session stays on ${deps.piProvider}`,
  );
}

function levelsOf(model: PiModel): string[] {
  return getSupportedThinkingLevels(model);
}

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-");
}

function matchModel(models: PiModel[], text: string): PiModel | undefined {
  const wanted = normalize(text);
  if (!wanted) return undefined;
  const exact = models.find(
    (m) => normalize(m.id) === wanted || normalize(m.name) === wanted,
  );
  if (exact) return exact;
  const partial = models.filter(
    (m) =>
      normalize(m.id).includes(wanted) || normalize(m.name).includes(wanted),
  );
  return partial.length === 1 ? partial[0] : undefined;
}

function findModel(models: PiModel[], text: string): PiModel {
  const model = matchModel(models, text);
  if (!model)
    throw new Error(
      `no model called "${text.trim()}"; this session can use ${models.map((m) => m.id).join(", ")}`,
    );
  return model;
}

function parseModelInput(
  models: PiModel[],
  input: string,
): { model: PiModel; effort?: string } {
  const whole = matchModel(models, input);
  if (whole) return { model: whole };
  const split = /^(.*\S)\s+(\S+)$/.exec(input);
  if (!split) return { model: findModel(models, input) };
  const model = findModel(models, split[1]);
  return { model, effort: findEffort(model, split[2]) };
}

function findEffort(model: PiModel, text: string): string {
  const levels = levelsOf(model);
  const level = levels.find(
    (l) => l.toLowerCase() === text.trim().toLowerCase(),
  );
  if (level) return level;
  throw new Error(
    levels.length > 1
      ? `${model.id} takes effort ${levels.join(", ")}, not "${text.trim()}"`
      : `${model.id} has no effort levels to choose from`,
  );
}

function modelQuestion(
  models: PiModel[],
  current: PiModel | undefined,
): QuestionItem {
  return {
    question: "Which model should this session use?",
    header: "Model",
    options: models.map((m) => ({
      label: m.id,
      ...(m.name !== m.id || m.id === current?.id
        ? {
            description: [
              m.name !== m.id ? m.name : undefined,
              m.id === current?.id ? "current" : undefined,
            ]
              .filter(Boolean)
              .join(" · "),
          }
        : {}),
    })),
    multiSelect: false,
  };
}

function effortQuestion(model: PiModel, session: AgentSession): QuestionItem {
  return {
    question: `Which effort should ${model.id} use?`,
    header: "Effort",
    options: levelsOf(model).map((level) => ({
      label: level,
      ...(model.id === session.model?.id && level === session.thinkingLevel
        ? { description: "current" }
        : {}),
    })),
    multiSelect: false,
  };
}
