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

/** The providers the Claude Engine runs on. */
export type ClaudeProviderConfig = AnthropicProviderConfig | BedrockProviderConfig;

export type ProviderConfig = ClaudeProviderConfig | CopilotProviderConfig;
