import { recordActivity } from "../../activity/model/activityStore";
import type { HarnessId } from "../../sessions/model/session";
import type { HarnessEvent } from "../../../integrations/harness/core/types";
import { TelemetryFeed } from "./telemetryFeed";

/**
 * The app's one feed, writing through the activity log's store (lane B's
 * `recordActivity`). `HarnessEventQueue.enqueue` taps it with every live
 * harness event, once; the host component feeds it the receiver's batches
 * and its timer.
 */
export const telemetryFeed = new TelemetryFeed((event) =>
  recordActivity(event),
);

/** Which harness each chat runs, kept by the host from the session list. */
const harnessByChat = new Map<string, HarnessId>();

export function setChatHarnesses(entries: Iterable<[string, HarnessId]>): void {
  harnessByChat.clear();
  for (const [id, harness] of entries) harnessByChat.set(id, harness);
}

/** The event types the feed reads. Everything else is skipped at once. */
export const TAPPED_EVENT_TYPES: ReadonlySet<HarnessEvent["type"]> = new Set([
  "tool.started",
  "tool.updated",
  "approval.requested",
  "approval.resolved",
  "turn.started",
  "turn.completed",
  "session.ended",
  "session.error",
]);

/** One live harness event. Never throws. */
export function tapHarnessEvent(sessionId: string, event: HarnessEvent): void {
  if (!TAPPED_EVENT_TYPES.has(event.type)) return;
  telemetryFeed.adapter(
    sessionId,
    harnessByChat.get(sessionId) ?? "",
    event,
    Date.now(),
  );
}

/**
 * A turn's end, from the registry's observer. It reaches the feed after the
 * turn's other events: those are tapped from the event queue in a promise
 * callback, and a timer runs after all of them. Not through the queue, which
 * the chat stops feeding once the user presses Stop (Mac test 2.2).
 */
export function tapTurnCompleted(sessionId: string, event: HarnessEvent): void {
  if (event.type !== "turn.completed") return;
  setTimeout(() => tapHarnessEvent(sessionId, event), 0);
}
