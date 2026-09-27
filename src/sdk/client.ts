import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";

/**
 * The connector's only door into the SDK's `query()`. Everything else imports
 * from here rather than the package directly, so there is one place the SDK
 * is reached from. Tests hand the Claude adapter a scripted `query()` of
 * their own instead.
 */
export const query: typeof realQuery = realQuery;
