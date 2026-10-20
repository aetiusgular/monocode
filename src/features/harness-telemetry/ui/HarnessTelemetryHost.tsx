import { useEffect, useMemo } from "react";
import type { HarnessId, Session } from "../../sessions/model/session";
import { useHarnessTelemetry } from "../model/telemetrySettings";
import {
  configureHarnessTelemetry,
  listenHarnessTelemetry,
} from "../model/telemetryBridge";
import {
  setChatHarnesses,
  tapTurnCompleted,
  telemetryFeed,
} from "../model/telemetryTap";
import { observeHarnessTurns } from "../../../integrations/harness/core/registry";

/** How often held adapter events are checked for writing. */
const TICK_MS = 2000;
/** A burst of session changes sends one configure call. */
const CONFIGURE_DEBOUNCE_MS = 300;

/**
 * Mounted once in App. Renders nothing. Keeps the receiver told which
 * sessions are chats and what the switches say, feeds the receiver's
 * batches into the telemetry feed, and runs the feed's timer.
 */
export function HarnessTelemetryHost({
  sessions,
}: {
  sessions: readonly Pick<Session, "id" | "harness">[];
}) {
  const settings = useHarnessTelemetry();
  const chats = useMemo(
    () => sessions.map((s) => [s.id, s.harness] as [string, HarnessId]),
    [sessions],
  );
  const chatKey = useMemo(() => chats.map(([id]) => id).join("\n"), [chats]);

  useEffect(() => {
    setChatHarnesses(chats);
  }, [chats]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void configureHarnessTelemetry(
        settings.enabled,
        settings.logPrompts,
        chatKey ? chatKey.split("\n") : [],
      );
    }, CONFIGURE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [settings.enabled, settings.logPrompts, chatKey]);

  useEffect(() => {
    const stop = listenHarnessTelemetry((events) =>
      telemetryFeed.otel(events, Date.now()),
    );
    const stopTurns = observeHarnessTurns(tapTurnCompleted);
    const timer = setInterval(() => telemetryFeed.tick(Date.now()), TICK_MS);
    const flush = () => telemetryFeed.flushAll();
    window.addEventListener("beforeunload", flush);
    return () => {
      stop();
      stopTurns();
      clearInterval(timer);
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, []);

  return null;
}
