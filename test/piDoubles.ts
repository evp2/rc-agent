import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  calculateCost,
  fauxAssistantMessage,
  type FauxModelDefinition,
  fauxProvider,
  type FauxProviderHandle,
  type FauxResponseStep,
  fauxToolCall,
  InMemoryCredentialStore,
  type JsonObject,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { PiEngine } from "../src/engine/pi/adapter.ts";
import type { PiProviderConfig } from "../src/provider.ts";

// Keeps every test off the developer's own ~/.pi.
const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

// A credential in the environment would leak into Pi's model choice and auth checks.
for (const key of Object.keys(process.env)) {
  if (/(_API_KEY|_AUTH_TOKEN|_OAUTH_TOKEN)$|^AWS_|^(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN)$/.test(key)) {
    delete process.env[key];
  }
}

export const FAUX_MODEL = "faux-model";

export function writePiSettings(settings: Record<string, unknown>): void {
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
}

export function freshProjectDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-project-"));
}

export interface PiTestEngine {
  engine: PiEngine;
  faux: FauxProviderHandle;
  projectDir: string;
  runtime(): ModelRuntime;
}

export function piEngineOn(
  responses: FauxResponseStep[],
  options: {
    piProvider?: string;
    provider?: PiProviderConfig;
    withFaux?: boolean;
    signedIn?: boolean;
    model?: Omit<FauxModelDefinition, "id">;
    subscription?: boolean;
    homeDir?: string;
  } = {},
): PiTestEngine {
  const faux = fauxProvider({
    provider: options.piProvider ?? "anthropic",
    models: [{ id: FAUX_MODEL, ...options.model }],
  });
  faux.setResponses(responses);
  const projectDir = freshProjectDir();
  let runtime: ModelRuntime | undefined;
  const engine = new PiEngine({
    provider: options.provider ?? { type: "anthropic", model: FAUX_MODEL },
    projectDir,
    homeDir: options.homeDir ?? freshProjectDir(),
    createModelRuntime: async () => {
      const credentials = new InMemoryCredentialStore();
      if (options.subscription) {
        await credentials.modify(faux.provider.id, async () => ({
          type: "oauth",
          access: "test-access",
          refresh: "test-refresh",
          expires: Date.now() + 24 * 60 * 60 * 1000,
        }));
      }
      runtime = await ModelRuntime.create({ credentials });
      const withFaux = options.withFaux ?? true;
      if (withFaux) runtime.registerNativeProvider(priced(faux.provider, { subscription: options.subscription ?? false }));
      if ((options.signedIn ?? withFaux) && !options.subscription) {
        await runtime.setRuntimeApiKey(faux.provider.id, "test-key");
      }
      return runtime;
    },
  });
  return {
    engine,
    faux,
    projectDir,
    runtime: () => {
      if (!runtime) throw new Error("no model runtime built yet");
      return runtime;
    },
  };
}

export const untilAborted: FauxResponseStep = (_context, options) =>
  new Promise((resolve) => {
    const settle = () => resolve(fauxAssistantMessage("never finished"));
    if (options?.signal?.aborted) settle();
    else options?.signal?.addEventListener("abort", settle, { once: true });
  });

// Keyed by prompt: a call Pi aborts before it reaches the model consumes no scripted step.
export function answeringByPrompt(answer: (prompt: string) => FauxResponseStep): {
  steps: FauxResponseStep[];
  prompts: string[];
} {
  const prompts: string[] = [];
  const step: FauxResponseStep = (context, options, state, model) => {
    const user = context.messages.filter((m) => m.role === "user").at(-1);
    const prompt =
      typeof user?.content === "string"
        ? user.content
        : (user?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
    prompts.push(prompt);
    const reply = answer(prompt);
    return typeof reply === "function" ? reply(context, options, state, model) : reply;
  };
  return { steps: Array.from({ length: 20 }, () => step), prompts };
}

export interface PiToolResult {
  text: string;
  isError: boolean;
}

export function callingTools(calls: { name: string; args: JsonObject; id: string }[]): {
  steps: FauxResponseStep[];
  results(): Map<string, PiToolResult>;
} {
  const results = new Map<string, PiToolResult>();
  const finish: FauxResponseStep = (context) => {
    for (const m of context.messages) {
      if (m.role !== "toolResult") continue;
      const text = m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      results.set(m.toolCallId, { text, isError: m.isError });
    }
    return fauxAssistantMessage("done");
  };
  return {
    steps: [
      fauxAssistantMessage(
        calls.map((c) => fauxToolCall(c.name, c.args, { id: c.id })),
        { stopReason: "toolUse" },
      ),
      finish,
    ],
    results: () => results,
  };
}

// Faux always reports zero cost, so each call is priced from the model's catalog.
function priced(provider: Provider, { subscription }: { subscription: boolean }): Provider {
  const withCost = (model: Model<string>, stream: AssistantMessageEventStream): AssistantMessageEventStream => {
    const price = (message: AssistantMessage) => {
      message.usage.cost = calculateCost(model, message.usage);
    };
    const push = stream.push.bind(stream);
    const end = stream.end.bind(stream);
    stream.push = (event) => {
      if (event.type === "done") price(event.message);
      if (event.type === "error") price(event.error);
      push(event);
    };
    stream.end = (result) => {
      if (result) price(result);
      end(result);
    };
    return stream;
  };
  return {
    ...provider,
    auth: subscription
      ? {
          ...provider.auth,
          oauth: {
            name: "Faux subscription",
            isSubscription: true,
            login: async () => {
              throw new Error("no login in tests");
            },
            refresh: async (credential) => credential,
            toAuth: async () => ({}),
          },
        }
      : provider.auth,
    stream: (model, context, options) => withCost(model, provider.stream(model, context, options)),
    streamSimple: (model, context, options) => withCost(model, provider.streamSimple(model, context, options)),
  };
}
