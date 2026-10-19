import type { EngineEvent } from "../engine/types";
import type { EventInput } from "../relay/client";

/**
 * Maps one neutral Engine event that describes a Turn's content -- anything
 * but the Turn boundaries, the Conversation, the announcement and the menu,
 * which the pump handles itself -- to the relay Events the phone renders.
 */
export function mapContentEvent(event: EngineEvent): EventInput[] {
  switch (event.type) {
    case "assistant_text":
      return event.text ? [{ type: "assistant_text", text: event.text }] : [];
    case "tool_use":
      return [
        {
          type: "tool_use",
          tool_name: event.name,
          tool_input: event.input,
          tool_use_id: event.toolUseId,
        },
      ];
    case "tool_result":
      return [
        {
          type: "tool_result",
          tool_use_id: event.toolUseId,
          text: event.text,
          is_error: event.isError,
        },
      ];
    case "status":
      return [{ type: "status", text: event.text }];
    case "compacting":
      // Only the Engine compacting on its own is news. A manual compaction is
      // a human's own `/compact`, or Auto-compact's -- both already-expected
      // Commands, not the involuntary case this reports. Fired before (or as)
      // the compaction starts, since nothing a human does from the phone can
      // stop one mid-Turn.
      if (event.trigger !== "auto") return [];
      return [
        {
          type: "status",
          text: "context window full — compacting automatically",
          context_overflow: true,
        },
      ];
    case "compacted": {
      const { preTokens, postTokens } = event;
      const text =
        preTokens === undefined
          ? "compacted"
          : postTokens === undefined
            ? `compacted (from ${preTokens} tokens)`
            : `compacted (${preTokens} → ${postTokens} tokens)`;
      return [{ type: "status", text }];
    }
    // Background-task lifecycle -- work the agent spawned that runs on its
    // own and may outlive the Turn. Each becomes an Event the phone renders
    // as an inline card and a live tray.
    case "task_started":
      return [
        {
          type: "background_task_started",
          task_id: event.taskId,
          tool_use_id: event.toolUseId,
          text: event.description,
          task_type: event.taskType,
          is_ambient: event.ambient,
        },
      ];
    case "task_settled":
      return [
        {
          type: "background_task_settled",
          task_id: event.taskId,
          tool_use_id: event.toolUseId,
          task_status: event.status,
          text: event.summary,
          is_ambient: event.ambient,
          duration_ms: event.durationMs,
        },
      ];
    // The level signal for the tray: the full live set, with REPLACE
    // semantics, so the phone swaps its set on each payload rather than
    // pairing started/settled edges.
    case "tasks_changed":
      return [
        {
          type: "background_tasks_changed",
          tasks: event.tasks.map((t) => ({
            task_id: t.taskId,
            task_type: t.taskType,
            description: t.description,
          })),
        },
      ];
    default:
      return [];
  }
}

/**
 * How long a gap between announcements makes the session banner worth
 * repeating. Someone returning to the tab after a break has scrolled past --
 * or never saw -- the last one, and which model is answering is worth
 * restating then.
 */
const BANNER_REPEAT_AFTER_MS = 60 * 60 * 1000;

/**
 * The session banner for an Engine's `announce`, deduplicated.
 *
 * An Engine may announce its model and permission mode at the start of every
 * Turn (Claude does, once per `system:init`), so turning each one into a line
 * puts the same "session started (model ..., permission ...)" above every
 * single reply. It is worth reading when it changes, or after a long enough
 * silence; in a continuous conversation it is noise, and on a phone it costs
 * a screenful.
 *
 * Stateful, so one must be shared by the whole process. A connector restart
 * makes a new one and therefore re-announces once, which is right: the phone
 * may have reloaded and lost the transcript above.
 */
export function createBannerDeduper(
  now: () => number = Date.now,
): (event: Extract<EngineEvent, { type: "announce" }>) => EventInput | undefined {
  let lastBanner: string | undefined;
  let lastBannerAt = 0;

  return (event) => {
    const banner = `session started (model ${event.model}, permission ${event.permissionMode})`;
    const at = now();
    // Timestamped on every announcement, not just the ones shown, so the
    // threshold measures silence between Turns rather than time since the
    // last banner -- a session busy for hours stays quiet.
    const repeat = banner !== lastBanner || at - lastBannerAt >= BANNER_REPEAT_AFTER_MS;
    lastBanner = banner;
    lastBannerAt = at;
    return repeat ? { type: "status", text: banner } : undefined;
  };
}
