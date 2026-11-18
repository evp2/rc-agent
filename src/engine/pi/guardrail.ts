import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { BedrockGuardrail } from "../../provider";

export const GUARDRAIL_ID_FLAG = "bedrock-guardrail-id";
export const GUARDRAIL_VERSION_FLAG = "bedrock-guardrail-version";

// Compaction and branch summaries call the runtime directly, bypassing the agent loop's payload hook and every extension.
export function applyGuardrail(runtime: Pick<ModelRuntime, "streamSimple">, guardrail: BedrockGuardrail): void {
  const send = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) =>
    send(model, context, {
      ...options,
      onPayload: async (payload, m) => {
        const changed = await options?.onPayload?.(payload, m);
        return guardedRequest(changed ?? payload, guardrail) ?? changed;
      },
    });
}

// Pi's request hook says nothing about the model, but only Bedrock's Converse request names it as `modelId`.
export function guardedRequest(payload: unknown, guardrail: BedrockGuardrail): unknown {
  if (typeof payload !== "object" || payload === null || typeof (payload as { modelId?: unknown }).modelId !== "string") {
    return undefined;
  }
  return {
    ...payload,
    guardrailConfig: { guardrailIdentifier: guardrail.identifier, guardrailVersion: guardrail.version },
  };
}
