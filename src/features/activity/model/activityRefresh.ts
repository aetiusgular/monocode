import type { HarnessEvent } from "../../../integrations/harness/core/types";

/**
 * When the Activity section reads the check again (Mac test 3.8, 3.12b).
 * The activity tap passes on each tool call's end and each harness start;
 * the section, while it is visible, reads on a call end, 11 s after the
 * last call end (the check's left-running grace is 10 s, `check.rs`
 * `LEFT_RUNNING_GRACE_MS`), and every 15 s as a backstop. A read never
 * starts while one is in flight.
 */

export const CALL_END_SETTLE_MS = 11_000;
export const BACKSTOP_MS = 15_000;

/** The statuses the telemetry feed treats as a call's end. */
const TERMINAL = new Set([
  "completed",
  "success",
  "failed",
  "error",
  "cancelled",
  "canceled",
]);

export function isCallEnd(event: HarnessEvent): boolean {
  if (event.type !== "tool.started" && event.type !== "tool.updated")
    return false;
  return typeof event.status === "string" && TERMINAL.has(event.status);
}

export type ActivityChange = "callEnd" | "restart";
type Listener = (chatId: string, what: ActivityChange) => void;

const listeners = new Set<Listener>();
const generations = new Map<string, number>();
const MAX_CHATS = 2_000;

/** How many times this chat's harness started; a restart reloads. */
export function harnessGeneration(chatId: string): number {
  return generations.get(chatId) ?? 0;
}

export function onActivityChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called from the activity tap for every live event. */
export function noteActivityEvent(chatId: string, event: HarnessEvent): void {
  let what: ActivityChange | null = null;
  if (event.type === "session.started") {
    if (!generations.has(chatId) && generations.size >= MAX_CHATS)
      generations.clear();
    generations.set(chatId, harnessGeneration(chatId) + 1);
    what = "restart";
  } else if (isCallEnd(event)) what = "callEnd";
  if (!what) return;
  for (const listener of [...listeners]) {
    try {
      listener(chatId, what);
    } catch {
      // One panel's error never stops another's.
    }
  }
}

/** Reads on demand, after the last call end settles, and on a backstop. */
export class RefreshScheduler {
  private inFlight = false;
  private settle: ReturnType<typeof setTimeout> | null = null;
  private backstop: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly load: () => Promise<void>) {}

  start(): void {
    this.stop();
    this.backstop = setInterval(() => this.now(), BACKSTOP_MS);
  }

  stop(): void {
    if (this.settle) clearTimeout(this.settle);
    if (this.backstop) clearInterval(this.backstop);
    this.settle = null;
    this.backstop = null;
  }

  /** A tool call ended: read now, and again once it would show as left running. */
  callEnded(): void {
    this.now();
    if (this.settle) clearTimeout(this.settle);
    this.settle = setTimeout(() => {
      this.settle = null;
      this.now();
    }, CALL_END_SETTLE_MS);
  }

  /** Reads unless a read is in flight. */
  now(): void {
    if (this.inFlight) return;
    this.inFlight = true;
    let done: Promise<void>;
    try {
      done = this.load();
    } catch {
      done = Promise.resolve();
    }
    void done
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = false;
      });
  }
}
