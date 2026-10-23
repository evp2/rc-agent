import { engineKindFor, type ConnectorConfig } from "../config";
import type { PiProviderConfig, ProviderConfig } from "../provider";
import { createClaudeEngine } from "./claude/adapter";
import { createCopilotEngine } from "./copilot/adapter";
import { createPiEngine } from "./pi/adapter";
import type { Engine } from "./types";

export function createEngine(config: ConnectorConfig): Engine {
  switch (engineKindFor(config)) {
    case "claude":
      return createClaudeEngine(providerFor(config.provider, "anthropic", "bedrock"));
    case "copilot":
      return createCopilotEngine(providerFor(config.provider, "copilot"));
    case "pi":
      return createPiEngine(config.provider, config.projectDir);
  }
}

function providerFor<T extends ProviderConfig["type"]>(
  provider: ProviderConfig | PiProviderConfig,
  ...types: T[]
): Extract<ProviderConfig, { type: T }> {
  if (!(types as string[]).includes(provider.type)) {
    throw new Error(`provider.type '${provider.type}' cannot run this Engine`);
  }
  return provider as Extract<ProviderConfig, { type: T }>;
}
