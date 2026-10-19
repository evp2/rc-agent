import type { ConnectorConfig } from "../config";
import { createClaudeEngine } from "./claude/adapter";
import { createCopilotEngine } from "./copilot/adapter";
import type { Engine } from "./types";

/** The Engine a connector drives, which its provider decides. */
export function createEngine(config: ConnectorConfig): Engine {
  switch (config.provider.type) {
    case "anthropic":
    case "bedrock":
      return createClaudeEngine(config.provider);
    case "copilot":
      return createCopilotEngine(config.provider);
  }
}
