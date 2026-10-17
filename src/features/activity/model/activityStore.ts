import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ActivityEvent, ApprovalRecord } from "./activityTypes";

/**
 * The TypeScript side of the activity log (wave 3, lane B). Records are
 * queued and sent to the app's Rust log in batches; the Rust side bounds and
 * chains them (`src-tauri/src/activity/store.rs`).
 *
 * Neither call ever throws to its caller, and neither waits: a log that
 * cannot be written must not stop a turn (rules, section 4, case 9). A full
 * queue drops the oldest record and counts it.
 */

export type ActivityTransport = {
  record(events: ActivityEvent[]): Promise<unknown>;
  recordApprovals(records: ApprovalRecord[]): Promise<unknown>;
};

/** Records held before the oldest is dropped. */
export const MAX_QUEUED = 1_000;
/** The Rust command takes at most this many in one call. */
export const MAX_BATCH = 500;
export const FLUSH_MS = 250;

const tauriTransport: ActivityTransport = {
  record: (events) => invoke("activity_record", { events }),
  recordApprovals: (records) =>
    invoke("activity_record_approvals", { records }),
};

let transport: ActivityTransport | null = null;
let events: ActivityEvent[] = [];
let approvals: ApprovalRecord[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let dropped = 0;

function currentTransport(): ActivityTransport | null {
  if (transport) return transport;
  try {
    return isTauri() ? tauriTransport : null;
  } catch {
    return null;
  }
}

/** For tests, and nothing else. `null` puts back the app's own. */
export function setActivityTransport(next: ActivityTransport | null): void {
  transport = next;
}

/** Records dropped by a full queue since the app started. */
export function droppedActivityRecords(): number {
  return dropped;
}

function schedule(): void {
  if (timer !== null) return;
  try {
    timer = setTimeout(() => {
      timer = null;
      void flushActivity();
    }, FLUSH_MS);
  } catch {
    timer = null;
  }
}

function push<T>(queue: T[], item: T): void {
  queue.push(item);
  if (queue.length > MAX_QUEUED) {
    queue.splice(0, queue.length - MAX_QUEUED);
    dropped += 1;
  }
}

/** Sends what is queued now. Resolves when the send settles; never rejects. */
export async function flushActivity(): Promise<void> {
  const target = currentTransport();
  const sendEvents = events.splice(0, MAX_BATCH);
  const sendApprovals = approvals.splice(0, MAX_BATCH);
  if (events.length || approvals.length) schedule();
  if (!target) return;
  const sends: Promise<unknown>[] = [];
  try {
    if (sendEvents.length) sends.push(target.record(sendEvents));
    if (sendApprovals.length) sends.push(target.recordApprovals(sendApprovals));
  } catch {
    return;
  }
  await Promise.allSettled(sends);
}

function wellFormed(value: { id?: unknown; chatId?: unknown }): boolean {
  return typeof value.id === "string" && typeof value.chatId === "string";
}

export function recordActivity(event: ActivityEvent): void {
  try {
    if (!event || !wellFormed(event)) return;
    push(events, event);
    schedule();
  } catch {
    // Never to the caller.
  }
}

/** Records what an approval card, rule or grant allowed. */
export function recordApproval(record: ApprovalRecord): void {
  try {
    if (!record || !wellFormed(record)) return;
    push(approvals, record);
    schedule();
  } catch {
    // Never to the caller.
  }
}

/** For tests: forget everything queued. */
export function resetActivityQueue(): void {
  events = [];
  approvals = [];
  dropped = 0;
  if (timer !== null) clearTimeout(timer);
  timer = null;
}
