import type { EngineEvent } from "../engine/types";
import { persist, publishSkills, trackBackgroundTasks } from "./commands";
import { attributionKey } from "./contribution";
import type { CurrentTurn, SessionContext } from "./context";
import { mapContentEvent } from "./engineEvents";
import { reportTurnEnded, stampContextReading } from "./turn";

/** Said on the phone when the Engine could not resume the Conversation the state file named, and started a fresh one. */
export const LOST_CONVERSATION_TEXT =
  "couldn't resume the previous conversation -- this is a fresh one, with no memory of it";

/** Who the Turn running right now belongs to: a Command's chain, or nobody (the Engine started it on its own). */
interface PumpState {
  owner: CurrentTurn | "engine" | undefined;
}

/**
 * Handles one Engine event: turns it into relay Events, persists what a
 * restart needs, and hands Turn boundaries to the Command chain they belong
 * to. Exported so a test can drive the pump one event at a time.
 */
export async function handleEngineEvent(
  ctx: SessionContext,
  event: EngineEvent,
  state: PumpState,
): Promise<void> {
  switch (event.type) {
    case "conversation":
      ctx.conversationId = event.id;
      // Still the state file's old key name, so older connectors and `rc-agent`
      // commands keep reading it.
      persist(ctx, { sdkSessionId: event.id });
      // A blank-memory agent must never be a surprise: said out loud, since
      // nothing else on the phone would show it.
      if (event.lostPrevious) ctx.eventBuffer.push({ type: "status", text: LOST_CONVERSATION_TEXT });
      return;

    case "announce": {
      const banner = ctx.bannerFor(event);
      if (banner) ctx.eventBuffer.push(banner);
      return;
    }

    case "menu":
      // Not awaited: a slow relay must not hold up the Turn events behind it.
      void publishSkills(ctx, event.skills, event.localCommands);
      return;

    case "turn_started": {
      const chain = ctx.currentTurn;
      if (chain?.owns(event.cause)) {
        state.owner = chain;
        await chain.onTurnStarted(event.cause);
      } else {
        chain?.onOtherTurnStarted();
        state.owner = "engine";
      }
      return;
    }

    case "turn_ended": {
      const owner = state.owner;
      state.owner = undefined;
      if (owner && owner !== "engine") {
        await owner.onTurnEnded(event);
      } else {
        // A Turn no Command is waiting on -- the Engine started it on its own.
        reportTurnEnded(ctx, event, { repo: await attributionKey(ctx.config.projectDir) });
      }
      return;
    }

    default: {
      const mapped = mapContentEvent(event);
      if (event.type === "compacted" && mapped[0]) stampContextReading(ctx, mapped[0], event.contextPercentage);
      trackBackgroundTasks(ctx, mapped);
      ctx.eventBuffer.push(...mapped);
    }
  }
}

/**
 * The session's one event pump: reads the Engine session's event stream for
 * the connector's whole life, handling each event in order. Resolves once the
 * stream ends (after the Engine session is closed), releasing any Command
 * chain still waiting on a Turn boundary that can no longer come.
 */
export async function pumpEngineEvents(ctx: SessionContext): Promise<void> {
  const state: PumpState = { owner: undefined };
  for await (const event of ctx.engineSession.events) {
    try {
      await handleEngineEvent(ctx, event, state);
    } catch (e) {
      // One bad event must not stop every later one from being handled.
      console.error(`Failed to handle an Engine ${event.type} event:`, (e as Error).message);
    }
  }
  ctx.currentTurn?.release();
}
