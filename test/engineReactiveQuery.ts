import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { AsyncQueue, takeOne } from "../src/asyncQueue.ts";
import type { ClaudeEngineDeps } from "../src/engine/claude/adapter.ts";

export interface ReactiveScript {
  /**
   * One message group per sub-turn, in order. The first group plays as soon
   * as the query starts; each later group plays only once something new
   * lands on the input queue -- a queued Command or a Steer, indistinguishable
   * to the fake, exactly as the real SDK doesn't care which one it was either.
   * A group with no trailing `result` message hangs there, open to being cut
   * short by the next thing that arrives (a Steer) or by an abort (a Stop).
   */
  subTurns: SDKMessage[][];
  /** After the last group finishes, hang until the abort signal fires -- models a still-open query with a Background task keeping it alive. */
  hangAfterLast?: boolean;
}

/**
 * Unlike test/claudeDoubles.ts's `scriptedQuery`, which ignores its `prompt`
 * argument entirely, this fake actually drains it for the query's whole
 * life -- the same behaviour the Claude adapter's `send`/`steer` depend on
 * the real SDK for. It reacts the instant something is pushed, with no
 * artificial pause, since it exists for fast adapter unit tests.
 */
export function reactiveQuery(script: ReactiveScript): ClaudeEngineDeps["query"] {
  return ({ prompt, options }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query => {
    const signal = options?.abortController?.signal;

    const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
      let mailbox: AsyncQueue<SDKUserMessage> | undefined;
      if (typeof prompt !== "string") {
        mailbox = new AsyncQueue<SDKUserMessage>();
        const iterable = prompt;
        if ((await takeOne(iterable)) === undefined) return;
        void (async () => {
          for await (const m of iterable) mailbox!.push(m);
        })();
      }

      let cursor = 0;
      for (;;) {
        const group = script.subTurns[cursor] ?? [];
        for (const m of group) yield m;
        cursor += 1;
        if (cursor >= script.subTurns.length) {
          if (script.hangAfterLast) {
            await new Promise<void>((resolve) => {
              if (!signal || signal.aborted) return resolve();
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
          return;
        }
        if (!mailbox) return;
        const { done } = await mailbox[Symbol.asyncIterator]().next();
        if (done) return;
      }
    })();

    return {
      [Symbol.asyncIterator]() {
        return gen;
      },
      next: (...a: Parameters<typeof gen.next>) => gen.next(...a),
      return: (v?: void) => gen.return(v),
      throw: (e?: unknown) => gen.throw(e),
      supportedCommands: async () => [],
      stopTask: async () => undefined,
      getContextUsage: async () => ({ percentage: 42 }),
    } as unknown as Query;
  };
}
