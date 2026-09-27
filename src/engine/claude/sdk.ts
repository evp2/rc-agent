import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";

/**
 * The Claude adapter's only door into the SDK's `query()`, so there is one
 * place the SDK is reached from. Tests hand the adapter a scripted `query()`
 * of their own instead.
 */
export const query: typeof realQuery = realQuery;
