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

export type ProviderConfig = AnthropicProviderConfig | BedrockProviderConfig;
