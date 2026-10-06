import type { Options, Query, SDKMessage, SDKUserMessage, SlashCommand } from "@anthropic-ai/claude-agent-sdk";

import { AsyncQueue } from "../src/asyncQueue.ts";
import type { ClaudeEngineDeps } from "../src/engine/claude/adapter.ts";

// Test doubles for the Claude adapter's own tests: scripted Claude SDK
// messages and a scripted `query()`. Everything above the Engine seam is
// tested against the fake Engine instead (see doubles.ts).

// --- SDK message constructors -------------------------------------------
// Only the fields the connector actually reads. Cast at the edge rather than
// building a whole valid SDKMessage, which would bury what each test is
// varying under a wall of irrelevant structure.

export function init(sessionId = "sdk-1"): SDKMessage {
  return initWithSkills([], sessionId);
}

/** An `init` naming the model-driven Skills, the way the real SDK tells them from Local commands. */
export function initWithSkills(skills: string[], sessionId = "sdk-1"): SDKMessage {
  return { type: "system", subtype: "init", session_id: sessionId, skills } as unknown as SDKMessage;
}

export function assistantText(text: string): SDKMessage {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  } as unknown as SDKMessage;
}

export function result(
  subtype: "success" | "error_during_execution" = "success",
  usage: {
    total_cost_usd?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    /** The SDK's running per-model totals for the whole query so far, as a real result carries them. */
    modelUsage?: Record<string, RunningModelTotals>;
  } = {},
): SDKMessage {
  return {
    type: "result",
    subtype,
    duration_ms: 5,
    total_cost_usd: usage.total_cost_usd ?? 0.001,
    is_error: subtype !== "success",
    result: subtype === "success" ? "done" : "failed",
    usage: {
      input_tokens: usage.input_tokens ?? 100,
      output_tokens: usage.output_tokens ?? 50,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 10,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 5,
    },
    modelUsage: Object.fromEntries(
      Object.entries(usage.modelUsage ?? {}).map(([model, m]) => [
        model,
        { webSearchRequests: 0, contextWindow: 200_000, maxOutputTokens: 32_000, ...m },
      ]),
    ),
  } as unknown as SDKMessage;
}

/** The fields of one `modelUsage` entry a Usage figure is read from. */
export interface RunningModelTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

export function compactBoundary(): SDKMessage {
  return {
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "manual", pre_tokens: 100 },
  } as unknown as SDKMessage;
}

export function taskStarted(taskId = "task-1"): SDKMessage {
  return {
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: "tool-1",
    description: "a long-running background task",
  } as unknown as SDKMessage;
}

/**
 * A Query over a fixed message list. `onStreamInput` fires when a Steer is
 * streamed in, which is what lets a test decide -- deterministically, rather
 * than by racing a timer -- whether the SDK ever answers it with a fresh
 * `init`.
 */
export function scriptedQuery(
  messages: SDKMessage[],
  opts: {
    commands?: SlashCommand[];
    onStreamInput?: (text: string, emit: (m: SDKMessage) => void) => void;
    streamInputThrows?: Error;
    /** Runs just before each message reaches the Turn, so a test can act at an exact point in the drain rather than racing a timer. */
    onYield?: (message: SDKMessage) => void | Promise<void>;
    /** Thrown from the drain after `throwAfter` messages, standing in for a subprocess that died mid-Turn. */
    throwAfter?: { count: number; error: Error };
    /** Percentages `getContextUsage()` returns, one per call in order; the last value repeats once exhausted. Defaults to a fixed 42. */
    contextPercentages?: number[];
    /** Called synchronously with the `options` a real `query()` call would receive, so a test can reach into `options.hooks` (e.g. to invoke PreCompact) exactly as the real SDK would. */
    onOptions?: (options: Options) => void;
    /**
     * Models the measured real-SDK behavior: after its last scripted message, the query's own generator does
     * not return -- exactly as a real query stays open for as long as a
     * Background task the Turn started keeps running -- and ends only once
     * the Turn is stopped (`options.abortController`'s signal fires). Without
     * a Stop, a query scripted this way never ends.
     */
    staysOpenAfterDrain?: boolean;
  } = {},
): { query: ClaudeEngineDeps["query"]; streamed: string[] } {
  const streamed: string[] = [];
  const query: ClaudeEngineDeps["query"] = ({ options }) => {
    opts.onOptions?.(options ?? {});
    const pending = new AsyncQueue<SDKMessage>();
    for (const m of messages) pending.push(m);
    pending.close();

    // Anything the persona injects mid-drain jumps ahead of the remaining
    // scripted messages, matching how a Steer truncates a real Turn.
    const injected: SDKMessage[] = [];
    let delivered = 0;
    const iterator = (async function* () {
      const deliver = async function* (m: SDKMessage) {
        if (opts.throwAfter && delivered >= opts.throwAfter.count) throw opts.throwAfter.error;
        await opts.onYield?.(m);
        delivered += 1;
        yield m;
      };
      for await (const m of pending) {
        while (injected.length) yield* deliver(injected.shift()!);
        yield* deliver(m);
      }
      while (injected.length) yield* deliver(injected.shift()!);
      if (opts.staysOpenAfterDrain) {
        const signal = options?.abortController?.signal;
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    })();

    const q = {
      [Symbol.asyncIterator]() {
        return q;
      },
      next: () => iterator.next(),
      return: (value?: void) => iterator.return(value),
      throw: (e?: unknown) => iterator.throw(e),
      supportedCommands: async () => opts.commands ?? [],
      stopTask: async () => undefined,
      streamInput: async (stream: AsyncIterable<SDKUserMessage>) => {
        if (opts.streamInputThrows) throw opts.streamInputThrows;
        for await (const m of stream) {
          const content = (m.message as { content?: unknown }).content;
          const text =
            typeof content === "string"
              ? content
              : ((content as { text?: string }[] | undefined)?.[0]?.text ?? "");
          streamed.push(text);
          opts.onStreamInput?.(text, (msg) => injected.push(msg));
        }
      },
      getContextUsage: (() => {
        let calls = 0;
        return async () => {
          const seq = opts.contextPercentages;
          if (!seq || seq.length === 0) return { percentage: 42 };
          const percentage = seq[Math.min(calls, seq.length - 1)];
          calls += 1;
          return { percentage };
        };
      })(),
    };
    return q as unknown as Query;
  };
  return { query, streamed };
}
