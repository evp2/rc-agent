import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { BedrockGuardrail } from "../../provider";

export const GUARDRAIL_ID_FLAG = "bedrock-guardrail-id";
export const GUARDRAIL_VERSION_FLAG = "bedrock-guardrail-version";

export function createGuardrailExtension(guardrail: BedrockGuardrail): ExtensionFactory {
  return (pi) => {
    pi.on("before_provider_request", (event) => guardedRequest(event.payload, guardrail));
  };
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
