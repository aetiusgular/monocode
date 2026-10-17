import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ActivityEvent } from "../../activity/model/activityTypes";

/** The window event the receiver sends batches on (otel_receiver.rs). */
export const TELEMETRY_EVENTS_CHANNEL = "harness-telemetry://events";

/** Most chat ids sent in one configure call (the receiver keeps 5,000). */
export const MAX_CHAT_IDS = 5000;

/** How long a configure call may take before the app stops waiting. */
const CONFIGURE_TIMEOUT_MS = 5000;

export type TelemetryStatus = {
  listening: boolean;
  requests: number;
  events: number;
  refusedToken: number;
  refusedOther: number;
  droppedRecords: number;
};

/**
 * Tells the receiver the switches and which sessions are chats. A failure
 * or a slow answer leaves telemetry as it was and never throws: no turn
 * waits on it (corner case 9).
 */
export async function configureHarnessTelemetry(
  enabled: boolean,
  logPrompts: boolean,
  chats: readonly string[],
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!isTauri()) return false;
    await Promise.race([
      invoke("harness_telemetry_configure", {
        enabled,
        logPrompts,
        chats: chats.slice(0, MAX_CHAT_IDS),
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("timeout")),
          CONFIGURE_TIMEOUT_MS,
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function harnessTelemetryStatus(): Promise<TelemetryStatus | null> {
  try {
    if (!isTauri()) return null;
    return await invoke<TelemetryStatus>("harness_telemetry_status");
  } catch {
    return null;
  }
}

/** Only well-formed OTel events from the receiver pass. */
export function isReceiverEvent(value: unknown): value is ActivityEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    e.source === "otel" &&
    typeof e.id === "string" &&
    typeof e.at === "number" &&
    typeof e.chatId === "string" &&
    typeof e.harness === "string" &&
    typeof e.kind === "string" &&
    typeof e.summary === "string" &&
    !!e.detail &&
    typeof e.detail === "object" &&
    !Array.isArray(e.detail)
  );
}

/** Listens for the receiver's batches. Returns the stop function. */
export function listenHarnessTelemetry(
  onEvents: (events: ActivityEvent[]) => void,
): () => void {
  try {
    if (!isTauri()) return () => {};
  } catch {
    return () => {};
  }
  let stopped = false;
  const subscription: Promise<UnlistenFn | void> = listen<unknown>(
    TELEMETRY_EVENTS_CHANNEL,
    (event) => {
      if (stopped || !Array.isArray(event.payload)) return;
      onEvents(event.payload.filter(isReceiverEvent));
    },
  ).catch(() => undefined);
  return () => {
    stopped = true;
    void subscription.then((unlisten) => unlisten?.());
  };
}
