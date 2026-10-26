import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { AsyncQueue, takeOne } from "../src/asyncQueue.ts";
import type { ClaudeEngineDeps } from "../src/engine/claude/adapter.ts";
import { taskNotification } from "./claudeDoubles.ts";

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
  selfStarted?: SDKMessage[];
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
    const liveTasks = new Set<string>();
    const stoppedTasks = new AsyncQueue<SDKMessage>();

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

      const track = (m: SDKMessage): SDKMessage => {
        if (m.type === "system" && m.subtype === "task_started") liveTasks.add(m.task_id);
        if (m.type === "system" && m.subtype === "task_notification") liveTasks.delete(m.task_id);
        return m;
      };

      let cursor = 0;
      for (;;) {
        const group = script.subTurns[cursor] ?? [];
        for (const m of group) yield track(m);
        cursor += 1;
        if (cursor >= script.subTurns.length) {
          if (script.selfStarted) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            for (const m of script.selfStarted) yield track(m);
          }
          if (script.hangAfterLast) {
            const aborted = new Promise<void>((resolve) => {
              if (!signal || signal.aborted) return resolve();
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            const stopped = stoppedTasks[Symbol.asyncIterator]();
            for (;;) {
              const next = await Promise.race([aborted.then(() => undefined), stopped.next()]);
              if (!next || next.done) break;
              yield track(next.value);
            }
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
      stopTask: async (taskId: string) => {
        if (liveTasks.has(taskId)) stoppedTasks.push(taskNotification(taskId, "stopped"));
      },
      getContextUsage: async () => ({ percentage: 42 }),
    } as unknown as Query;
  };
}
