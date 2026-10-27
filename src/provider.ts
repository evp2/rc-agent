export interface AnthropicProviderConfig {
  type: "anthropic";
  apiKeyEnv?: string;
}

export interface BedrockProviderConfig {
  type: "bedrock";
  /** Optional -- falls back to the ambient AWS_REGION/AWS_DEFAULT_REGION. */
  region?: string;
  /** Optional -- falls back to the ambient ANTHROPIC_MODEL, else the SDK default. */
  model?: string;
}

export interface CopilotProviderConfig {
  type: "copilot";
  /** A Copilot model id. `auto` lets Copilot choose per Turn. */
  model: string;
  /** The `copilot` executable to run. Absent means the one on the PATH. */
  cliPath?: string;
}

export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export interface SubagentProfile {
  /** Pi's `provider/id` form, as `pi --model` takes it. Absent inherits the session's current model. */
  model?: string;
  thinkingLevel?: PiThinkingLevel;
  description?: string;
}

export interface SubagentProfiles {
  default?: SubagentProfile;
  profiles?: Record<string, SubagentProfile>;
}

export interface PiProviderConfig {
  type: ProviderConfig["type"];
  model?: string;
  thinkingLevel?: PiThinkingLevel;
  subagents?: SubagentProfiles;
}

/** The providers the Claude Engine runs on. */
export type ClaudeProviderConfig = AnthropicProviderConfig | BedrockProviderConfig;

export type ProviderConfig = ClaudeProviderConfig | CopilotProviderConfig;
