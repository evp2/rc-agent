import assert from "node:assert/strict";
import { test } from "node:test";

import type { EventInput } from "../src/relay/client.ts";
import { flushEvents } from "../src/session/events.ts";
import type { SessionContext } from "../src/session/context.ts";
import { FakeRelay } from "./doubles.ts";

const status = (text: string): EventInput => ({ type: "status", text });

function contextOver(relay: FakeRelay, buffered: EventInput[]): SessionContext {
  return { client: relay, eventBuffer: buffered, sessionEnded: false, running: false, flushChain: Promise.resolve() } as never;
}

class RefusingRelay extends FakeRelay {
  down = false;
  attempts = 0;
  constructor(private readonly refused: string) {
    super();
  }
  override async postEvents(events: EventInput[]): Promise<number> {
    this.attempts++;
    if (this.down || events.some((e) => e.text === this.refused)) throw new Error("postEvents failed: HTTP 500");
    return super.postEvents(events);
  }
}

test("flushEvents: an Event the relay refuses is dropped, and the Events around it still arrive", async () => {
  const relay = new RefusingRelay("poison");
  const ctx = contextOver(relay, [status("a"), status("poison"), status("b")]);

  await flushEvents(ctx);

  assert.deepEqual(relay.posted.map((e) => e.text), ["a", "b"]);
  assert.deepEqual(ctx.eventBuffer, []);
});

test("flushEvents: while the relay is refusing everything, every Event is kept for the next flush", async () => {
  const relay = new RefusingRelay("poison");
  relay.down = true;
  const ctx = contextOver(relay, [status("a"), status("b")]);

  await flushEvents(ctx);

  assert.deepEqual(relay.posted, []);
  assert.deepEqual(ctx.eventBuffer.map((e) => e.text), ["a", "b"]);
});

test("flushEvents: during an outage a flush gives up after a few refusals instead of trying every Event", async () => {
  const relay = new RefusingRelay("poison");
  relay.down = true;
  const ctx = contextOver(relay, Array.from({ length: 20 }, (_, i) => status(`e${i}`)));

  await flushEvents(ctx);

  assert.ok(relay.attempts <= 4, `${relay.attempts} attempts`);
  assert.equal(ctx.eventBuffer.length, 20);
});

test("flushEvents: a lone Event refused flush after flush is dropped, but not on the first refusal", async () => {
  const relay = new RefusingRelay("poison");
  const ctx = contextOver(relay, [status("poison")]);

  await flushEvents(ctx);
  assert.equal(ctx.eventBuffer.length, 1, "one refusal could be an outage");
  for (let i = 0; i < 10 && ctx.eventBuffer.length; i++) await flushEvents(ctx);

  assert.deepEqual(ctx.eventBuffer, []);
  assert.deepEqual(relay.posted, []);
});
