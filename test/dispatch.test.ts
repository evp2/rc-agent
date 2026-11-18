import assert from "node:assert/strict";
import { test } from "node:test";

import { sayAndFinish, type FakeTurnContext, type FakeTurnHandler } from "../src/engine/fakeEngine.ts";
import type { CommandRecord } from "../src/relay/client.ts";
import { runTurn } from "../src/session/turn.ts";
import { checkForSteer } from "../src/session/watchers.ts";
import { cmd, dispatchCmd, makeTurnHarness, until, type FakeRelay, type TurnHarness } from "./doubles.ts";

/** Runs one Turn for `command` whose body is `body`, and returns what it produced. */
async function inTurn<T>(
  command: CommandRecord,
  body: (turn: FakeTurnContext) => Promise<T>,
  arrange: (relay: FakeRelay) => void = () => {},
): Promise<{ h: TurnHarness; result: T }> {
  let result: T | undefined;
  const h = await makeTurnHarness({
    handlerFor: () => async (turn) => {
      result = await body(turn);
    },
  });
  arrange(h.relay);
  await runTurn(h.ctx, command);
  return { h, result: result as T };
}

test("list_siblings returns only each sibling's id, project directory, Engine and name", async () => {
  const { h, result } = await inTurn(
    cmd("who can I reach"),
    (turn) => turn.listSiblings(),
    (relay) => {
      relay.siblings = [
        {
          session_id: "s2",
          project_dir: "/work/connector",
          engine: "pi",
          name: "connector",
          secret: "shh",
          control_code: "ABCD",
        },
      ];
    },
  );

  assert.deepEqual(result, {
    siblings: [{ sessionId: "s2", projectDir: "/work/connector", engine: "pi", name: "connector" }],
  });
  await h.close();
});

test("list_siblings reports a relay failure as a reason", async () => {
  const { h, result } = await inTurn(
    cmd("who can I reach"),
    (turn) => turn.listSiblings(),
    (relay) => {
      relay.failNextListSiblings = new Error("HTTP 502");
    },
  );

  assert.ok("reason" in result);
  assert.match(result.reason, /502/);
  await h.close();
});

test("send_dispatch hands the relay the target and text and reports it held", async () => {
  const { h, result } = await inTurn(cmd("hand it over"), (turn) => turn.sendDispatch({ to: "s2", text: "run the migration" }));

  assert.deepEqual(result, { sent: true });
  assert.deepEqual(h.relay.dispatches, [{ to: "s2", text: "run the migration" }]);
  await h.close();
});

const REFUSALS: [reason: string, expected: RegExp][] = [
  ["no_such_sibling", /no sibling session with that id/i],
  ["target_ended", /ended/i],
  ["text_too_long", /too long/i],
  ["too_many_held", /too many/i],
  ["from_dispatch_turn", /started by a Dispatch/i],
];

for (const [reason, expected] of REFUSALS) {
  test(`send_dispatch tells the agent what a ${reason} refusal means`, async () => {
    const { h, result } = await inTurn(
      cmd("hand it over"),
      (turn) => turn.sendDispatch({ to: "s2", text: "x" }),
      (relay) => {
        relay.dispatchResult = { held: false, reason, error: "relay words" };
      },
    );

    assert.ok(!result.sent);
    assert.match(result.reason, expected);
    await h.close();
  });
}

test("send_dispatch relays the relay's own message for a refusal it does not recognise", async () => {
  const { h, result } = await inTurn(
    cmd("hand it over"),
    (turn) => turn.sendDispatch({ to: "s2", text: "x" }),
    (relay) => {
      relay.dispatchResult = { held: false, reason: "brand_new_reason", error: "the moon is full" };
    },
  );

  assert.ok(!result.sent);
  assert.match(result.reason, /the moon is full/);
  await h.close();
});

test("send_dispatch reports a relay failure as a reason", async () => {
  const { h, result } = await inTurn(
    cmd("hand it over"),
    (turn) => turn.sendDispatch({ to: "s2", text: "x" }),
    (relay) => {
      relay.failNextDispatch = new Error("socket hang up");
    },
  );

  assert.ok(!result.sent);
  assert.match(result.reason, /socket hang up/);
  await h.close();
});

test("a Turn a promoted Dispatch started cannot send a Dispatch, and the relay is never asked", async () => {
  const { h, result } = await inTurn(dispatchCmd("do the thing"), (turn) => turn.sendDispatch({ to: "s2", text: "and you" }));

  assert.ok(!result.sent);
  assert.match(result.reason, /started by a Dispatch/i);
  assert.deepEqual(h.relay.dispatches, []);
  await h.close();
});

test("a Turn a promoted Dispatch started can still list siblings", async () => {
  const { h, result } = await inTurn(dispatchCmd("do the thing"), (turn) => turn.listSiblings());

  assert.deepEqual(result, { siblings: [] });
  await h.close();
});

test("a promoted Dispatch reaches the Engine labelled with its sender, apart from the user's words", async () => {
  let received: string | undefined;
  const h = await makeTurnHarness({
    handlerFor: (_cause, text) => {
      received = text;
      return sayAndFinish("on it");
    },
  });

  await runTurn(h.ctx, dispatchCmd("rotate the keys", "s-relay", "/work/relay"));

  assert.ok(received);
  assert.match(received, /s-relay/);
  assert.match(received, /\/work\/relay/);
  assert.match(received, /not from the user/i);
  assert.ok(received.includes("rotate the keys"));
  assert.notEqual(received, "rotate the keys");
  await h.close();
});

test("a Command from the phone reaches the Engine unframed", async () => {
  let received: string | undefined;
  const h = await makeTurnHarness({
    handlerFor: (_cause, text) => {
      received = text;
      return sayAndFinish("ok");
    },
  });

  await runTurn(h.ctx, cmd("just my words"));

  assert.equal(received, "just my words");
  await h.close();
});

const workUntilInterrupted: FakeTurnHandler = async (ctx) => {
  ctx.emit({ type: "assistant_text", text: "working" });
  await ctx.waitForInterruption();
  return ctx.stopped ? { outcome: "stopped" } : { outcome: "success" };
};

test("a promoted Dispatch arriving mid-Turn queues behind it instead of Steering it", async () => {
  const causes: string[] = [];
  const h = await makeTurnHarness({
    handlerFor: (cause, text) => {
      causes.push(cause);
      return text === "first" ? workUntilInterrupted : sayAndFinish("ran");
    },
  });
  const dispatched = dispatchCmd("a dispatched task");
  let served = false;
  h.relay.pollCommands = async () => {
    if (served) return [];
    served = true;
    return [dispatched];
  };

  const turn = runTurn(h.ctx, cmd("first"));
  await until(() => !!h.ctx.currentTurn?.running);
  await checkForSteer(h.ctx);

  assert.deepEqual(h.ctx.handBackBuffer, [dispatched]);
  assert.ok(!h.ctx.currentTurn?.steeredThisSubTurn, "the Turn's one Steer is still unspent");
  h.ctx.engineSession.stop();
  await turn;
  assert.deepEqual(causes, ["command"]);
  await h.close();
});

test("a promoted Dispatch arriving while the Engine works on its own waits for that Turn to end", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const causes: string[] = [];
  const h = await makeTurnHarness({
    handlerFor: (cause) => {
      causes.push(cause);
      return cause === "engine"
        ? async (ctx) => {
            ctx.emit({ type: "assistant_text", text: "working alone" });
            await Promise.race([gate, ctx.waitForInterruption()]);
            return { outcome: "success" };
          }
        : sayAndFinish("ran the dispatch");
    },
  });
  h.session.triggerEngineTurn();
  await until(() => h.ctx.eventBuffer.some((e) => e.text === "working alone"));
  await until(() => !!h.ctx.engineTurn);

  const dispatched = runTurn(h.ctx, dispatchCmd("a dispatched task"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(causes, ["engine"], "the Engine's own Turn was not Steered");
  release();
  await dispatched;

  assert.deepEqual(causes, ["engine", "command"]);
  await h.close();
});
