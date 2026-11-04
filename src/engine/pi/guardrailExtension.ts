import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { BedrockGuardrail } from "../../provider";
import { GUARDRAIL_ID_FLAG, GUARDRAIL_VERSION_FLAG, guardedRequest } from "./guardrail";

// Pi catches a throwing handler and sends the request anyway, so a refusal has to end the process.
export function subagentGuardrailExtension(refuse: (message: string) => never): ExtensionFactory {
  return (pi) => {
    pi.registerFlag(GUARDRAIL_ID_FLAG, { type: "string", description: "Bedrock guardrail identifier" });
    pi.registerFlag(GUARDRAIL_VERSION_FLAG, { type: "string", description: "Bedrock guardrail version" });
    const required = (): BedrockGuardrail => {
      const identifier = pi.getFlag(GUARDRAIL_ID_FLAG);
      const version = pi.getFlag(GUARDRAIL_VERSION_FLAG);
      if (typeof identifier !== "string" || identifier.length === 0) {
        return refuse(`--${GUARDRAIL_ID_FLAG} is required and must be non-empty`);
      }
      if (typeof version !== "string" || version.length === 0) {
        return refuse(`--${GUARDRAIL_VERSION_FLAG} is required and must be non-empty`);
      }
      return { identifier, version };
    };
    // Flag values reach Pi only after every factory has run, so session_start is the first point they can be read.
    pi.on("session_start", () => {
      required();
    });
    pi.on("before_provider_request", (event) => guardedRequest(event.payload, required()));
  };
}

export default subagentGuardrailExtension((message) => {
  process.stderr.write(`Bedrock guardrail not applied, refusing to run: ${message}\n`);
  process.exit(1);
});
