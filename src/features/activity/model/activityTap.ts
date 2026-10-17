import type { HarnessEvent } from "../../../integrations/harness/core/types";

/**
 * The one place a live harness event reaches the activity log: the app's
 * event queue calls the tap from `HarnessEventQueue.enqueue`, once per event.
 *
 * The queue reads the tap from `globalThis` rather than importing this file,
 * so the shared queue file gains no import line that another lane's could
 * collide with (wave 3 markers have no import hook there). Nothing is
 * installed until the activity bridge mounts; until then the call is a no-op.
 */
export const ACTIVITY_TAP_KEY = "monocodeActivityTap_w3b";

export type ActivityTap = (sessionId: string, event: HarnessEvent) => void;

type TapHost = { [ACTIVITY_TAP_KEY]?: ActivityTap };

/** Installs `tap`, wrapped so it can never throw into the queue. */
export function installActivityTap(tap: ActivityTap): () => void {
  const safe: ActivityTap = (sessionId, event) => {
    try {
      tap(sessionId, event);
    } catch {
      // The log never stops the stream (rules, section 4, case 9).
    }
  };
  (globalThis as TapHost)[ACTIVITY_TAP_KEY] = safe;
  return () => {
    if ((globalThis as TapHost)[ACTIVITY_TAP_KEY] === safe)
      delete (globalThis as TapHost)[ACTIVITY_TAP_KEY];
  };
}

/** What the queue calls. */
export function callActivityTap(sessionId: string, event: HarnessEvent): void {
  (globalThis as TapHost)[ACTIVITY_TAP_KEY]?.(sessionId, event);
}
