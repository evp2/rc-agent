import { engineKindFor, type ConnectorConfig } from "../config";
import { createClaudeEngine } from "./claude/adapter";
import type { Engine } from "./types";

/** The Engine a connector drives, which its provider decides. */
export function createEngine(config: ConnectorConfig): Engine {
  switch (engineKindFor(config.provider)) {
    case "claude":
      return createClaudeEngine(config.provider);
    case "copilot":
      throw new Error("The Copilot Engine is not available yet.");
  }
}
