import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ActivityEvent } from "./activityTypes";

/**
 * B6: what the panel reads. The check runs in Rust
 * (`src-tauri/src/activity/check.rs`); this file asks for its flags, keeps
 * "your last visit" per chat, and names each flag in plain words.
 */

export type FlagReason =
  | "appNotGranted"
  | "writeOutsideFolders"
  | "leftRunning"
  | "sensitivePath"
  | "newHost"
  | "recordingOff";

/** Where in the chat's process tree a collector event came from. */
export type FlagTier = "root" | "harnessChild" | "tool";

export type ActivityFlag = {
  id: string;
  chatId: string;
  at: number;
  reason: FlagReason;
  summary: string;
  eventId: string;
  context: string[];
  screenshot?: string;
  /** Events this row stands for; `at` is the first, `lastAt` the last. */
  count?: number;
  lastAt?: number;
  tier?: FlagTier;
};

/** Whether the collector answered: unknown until it was asked. */
export type CollectorReachable = "unknown" | "yes" | "no";

export type FlagsReport = {
  flags: ActivityFlag[];
  events: ActivityEvent[];
  chainOk: boolean;
  collectorChainOk?: boolean;
  collectorReachable: CollectorReachable;
  /** `timeout`, `truncated`, `not running`, `refused` or `eslogger: <line>`. */
  collectorReason?: string;
  truncated: boolean;
  dropped: number;
  /** Rows the check hid as expected, for the toggle. */
  expected: ActivityFlag[];
  /** Events hidden per rule. */
  suppressed: Record<string, number>;
};

export const REASON_LABEL: Record<FlagReason, string> = {
  appNotGranted: "App not granted",
  writeOutsideFolders: "Outside the chat's folders",
  leftRunning: "Left running",
  sensitivePath: "Sensitive file",
  newHost: "New host",
  recordingOff: "Recording off",
};

export const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const VISIT_KEY = "monocode.activity.lastVisit";
const MAX_VISITS = 500;

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function readVisits(): Record<string, number> {
  try {
    const raw = storage()?.getItem(VISIT_KEY);
    const value: unknown = raw ? JSON.parse(raw) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Record<string, number> = {};
    for (const [chat, at] of Object.entries(value as Record<string, unknown>))
      if (typeof at === "number" && Number.isFinite(at) && chat.length <= 128)
        out[chat] = at;
    return out;
  } catch {
    return {};
  }
}

/** When you last marked this chat's flags seen, or `undefined`. */
export function lastVisit(chatId: string): number | undefined {
  return readVisits()[chatId];
}

export function markVisited(chatId: string, at: number = Date.now()): void {
  try {
    const visits = readVisits();
    visits[chatId] = at;
    const entries = Object.entries(visits).sort((a, b) => b[1] - a[1]);
    storage()?.setItem(
      VISIT_KEY,
      JSON.stringify(Object.fromEntries(entries.slice(0, MAX_VISITS))),
    );
  } catch {
    // A visit that is not saved shows the same flags again; nothing breaks.
  }
}

/** Where the panel starts reading: your last visit, at most 7 days back. */
export function sinceFor(chatId: string, now: number = Date.now()): number {
  const visited = lastVisit(chatId);
  const floor = now - KEEP_MS;
  return visited === undefined ? floor : Math.max(visited, floor);
}

export const EMPTY_REPORT: FlagsReport = {
  flags: [],
  events: [],
  chainOk: true,
  collectorReachable: "unknown",
  truncated: false,
  dropped: 0,
  expected: [],
  suppressed: {},
};

/** An empty report that keeps what is known about the collector, for Mark seen. */
export function keepCollectorState(report: FlagsReport): FlagsReport {
  return {
    ...EMPTY_REPORT,
    collectorReachable: report.collectorReachable,
    ...(report.collectorReason
      ? { collectorReason: report.collectorReason }
      : {}),
    ...(report.collectorChainOk === undefined
      ? {}
      : { collectorChainOk: report.collectorChainOk }),
  };
}

/** A reply from an older app build, filled to this shape. */
function normalize(raw: FlagsReport): FlagsReport {
  const reach = raw.collectorReachable as unknown;
  return {
    ...EMPTY_REPORT,
    ...raw,
    collectorReachable:
      reach === "yes" || reach === "no" || reach === "unknown"
        ? reach
        : reach === true
          ? "yes"
          : "unknown",
    expected: Array.isArray(raw.expected) ? raw.expected : [],
    suppressed:
      raw.suppressed && typeof raw.suppressed === "object"
        ? raw.suppressed
        : {},
  };
}

/** "N expected events hidden", or null when none were. */
export function expectedNote(report: FlagsReport): string | null {
  const total = Object.values(report.suppressed).reduce(
    (sum, n) => sum + (Number.isFinite(n) && n > 0 ? n : 0),
    0,
  );
  if (!total) return null;
  return `${total} expected event${total === 1 ? "" : "s"} hidden`;
}

/** The check's flags for one chat. Outside the app, or on any error, none. */
export async function fetchFlags(
  chatId: string,
  since: number,
): Promise<FlagsReport> {
  try {
    if (!isTauri()) return EMPTY_REPORT;
    return normalize(
      await invoke<FlagsReport>("activity_flags", {
        chatId,
        since,
        until: null,
      }),
    );
  } catch {
    return EMPTY_REPORT;
  }
}

export async function fetchScreenshot(path: string): Promise<string | null> {
  try {
    if (!isTauri()) return null;
    const url = await invoke<string>("activity_screenshot", { path });
    return url.startsWith("data:image/png;base64,") ? url : null;
  } catch {
    return null;
  }
}

/** The events a flag names, oldest first. */
export function eventsAround(
  flag: ActivityFlag,
  events: readonly ActivityEvent[],
): ActivityEvent[] {
  const wanted = new Set(flag.context);
  return events
    .filter((event) => wanted.has(event.id))
    .sort((a, b) => a.at - b.at);
}

/** Notes about the log itself, shown above the flags. */
export function reportNotes(report: FlagsReport): string[] {
  const notes: string[] = [];
  if (!report.chainOk)
    notes.push(
      "This app's activity log does not verify: a line was changed or removed.",
    );
  if (report.collectorChainOk === false)
    notes.push(
      "The collector's log does not verify: a line was changed or removed.",
    );
  const reason = report.collectorReason;
  if (report.collectorReachable === "no") {
    notes.push(
      reason === "refused"
        ? "The collector refused this app, so file and process events are not checked. A development build needs the install that names it. Settings, Activity log."
        : reason === "timeout"
          ? "The collector did not answer in time, so file and process events are not checked."
          : "The collector is not running, so file and process events are not checked. Settings, Activity log.",
    );
  } else if (report.collectorReachable === "yes") {
    if (reason?.startsWith("eslogger: "))
      notes.push(
        `eslogger stopped: ${reason.slice("eslogger: ".length)}. New file and process events are not recorded. Settings, Activity log.`,
      );
    else if (reason === "timeout")
      notes.push(
        "The collector took too long to answer; what arrived is checked.",
      );
    else if (reason === "truncated")
      notes.push(
        "The collector's answer was cut short; what arrived is checked.",
      );
  }
  if (report.truncated)
    notes.push(
      "More happened than the panel reads at once; the newest is shown.",
    );
  if (report.dropped > 0)
    notes.push(
      `${report.dropped} record${report.dropped === 1 ? " was" : "s were"} dropped when the log fell behind.`,
    );
  return notes;
}
