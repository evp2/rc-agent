import { SessionEndedError, type EventInput } from "../relay/client";
import type { SessionContext } from "./context";

// The relay rejects any batch larger than this, so flushes must be chunked --
// a busy turn can easily buffer more than this in one flush interval.
const MAX_EVENTS_PER_BATCH = 25;
// A lone Event the relay refuses this many flushes running is dropped, since the relay may just be down.
const MAX_LONE_REFUSALS = 5;
const MAX_LEADING_REFUSALS = 3;
// Ceiling on retained events when the relay is failing, so a prolonged outage
// can't grow the buffer without bound.
const MAX_BUFFERED_EVENTS = 1000;

const loneRefusals = new WeakMap<EventInput, number>();

/**
 * Re-posts a refused batch one Event at a time. Events the relay refuses while
 * it accepts others are dropped, since retrying them would hold back every
 * Event behind them; if it accepts none, they are all kept.
 */
async function postSeparately(ctx: SessionContext, batch: EventInput[]): Promise<boolean> {
  const refused: EventInput[] = [];
  let accepted = 0;
  for (const event of batch) {
    try {
      await ctx.client.postEvents([event]);
      accepted++;
    } catch (e) {
      if (e instanceof SessionEndedError) throw e;
      refused.push(event);
      // Each refusal can take a full request timeout, so an outage gives up early.
      if (!accepted && refused.length === MAX_LEADING_REFUSALS) return false;
    }
  }
  if (!accepted) return false;
  for (const event of refused) console.error(`Relay refused an Event, dropping it: ${event.type} ${event.tool_name ?? ""}`);
  return true;
}

/**
 * Posts the buffer in relay-sized chunks, oldest first. Events are only
 * removed from the buffer once the relay has accepted them: dropping a failed
 * batch can lose the `turn_complete` that re-enables the phone's composer,
 * which strands the UI mid-turn with no error shown.
 */
async function doFlush(ctx: SessionContext): Promise<void> {
  while (ctx.eventBuffer.length > 0 && !ctx.sessionEnded) {
    const batch = ctx.eventBuffer.slice(0, MAX_EVENTS_PER_BATCH);
    try {
      await ctx.client.postEvents(batch);
      ctx.eventBuffer = ctx.eventBuffer.slice(batch.length);
    } catch (e) {
      if (e instanceof SessionEndedError) {
        ctx.sessionEnded = true;
        ctx.running = false;
        ctx.eventBuffer = [];
        return;
      }
      console.error("Failed to flush events, will retry:", (e as Error).message);
      if (await separated(ctx, batch)) continue;
      if (ctx.eventBuffer.length > MAX_BUFFERED_EVENTS) {
        const dropped = ctx.eventBuffer.length - MAX_BUFFERED_EVENTS;
        console.error(`Event buffer full, dropping ${dropped} oldest events.`);
        ctx.eventBuffer = ctx.eventBuffer.slice(dropped);
      }
      return;
    }
  }
}

async function separated(ctx: SessionContext, batch: EventInput[]): Promise<boolean> {
  try {
    if (batch.length > 1) {
      if (!(await postSeparately(ctx, batch))) return false;
    } else {
      const refusals = (loneRefusals.get(batch[0]) ?? 0) + 1;
      loneRefusals.set(batch[0], refusals);
      if (refusals < MAX_LONE_REFUSALS) return false;
      console.error(`Relay refused an Event ${refusals} times, dropping it: ${batch[0].type} ${batch[0].tool_name ?? ""}`);
    }
  } catch (e) {
    if (!(e instanceof SessionEndedError)) throw e;
    ctx.sessionEnded = true;
    ctx.running = false;
    ctx.eventBuffer = [];
    return true;
  }
  ctx.eventBuffer = ctx.eventBuffer.slice(batch.length);
  return true;
}

/** Serialises flushes so event order stays stable when a flush outlives its interval tick, and so shutdown can await every queued flush. */
export function flushEvents(ctx: SessionContext): Promise<void> {
  ctx.flushChain = ctx.flushChain.then(() => doFlush(ctx), () => undefined);
  return ctx.flushChain;
}

/**
 * Posts one Event on its own, after everything already buffered, and rejects
 * if the relay refuses it -- for an Event whose sender must hear that it was
 * rejected. It never joins the buffer: a batch the relay rejects outright
 * would be retried forever, holding back every Event behind it.
 */
export function postAfterBuffered(ctx: SessionContext, event: EventInput): Promise<void> {
  const posted = flushEvents(ctx).then(async () => {
    await ctx.client.postEvents([event]);
  });
  ctx.flushChain = posted.catch(() => undefined);
  return posted;
}
