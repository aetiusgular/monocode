/**
 * One chat rewind at a time per chat, with a bounded wait (#34).
 *
 * The harness forgets first; only then is the transcript cut. Claude Code
 * restarts to forget, and loads the whole conversation before it answers, so
 * a rewind can take a while. The menu must still never wait forever, and a
 * second press must not queue a second rewind behind the first.
 */

/** How long the menu waits for a chat rewind before it shows an error. */
export const CHAT_REWIND_TIMEOUT_MS = 45_000;

export const CHAT_REWIND_RUNNING_MESSAGE =
  "A rewind of this chat is still running. Wait for it to finish";

const running = new Set<string>();

/** True while a chat rewind of `sessionId` has not settled. */
export function chatRewindRunning(sessionId: string): boolean {
  return running.has(sessionId);
}

export class ChatRewindTimeoutError extends Error {
  constructor(seconds: number) {
    super(
      `The agent did not finish going back within ${seconds} s. The chat is left as it was for now; if the agent finishes later, the chat is rewound then`,
    );
    this.name = "ChatRewindTimeoutError";
  }
}

/**
 * Runs `forget` (the harness side), then `cut` (the transcript and the
 * composer), at most once at a time per chat.
 *
 * - A second call while one runs is refused, not queued.
 * - A `forget` that fails leaves the transcript alone and rethrows.
 * - A `forget` that takes longer than `timeoutMs` rejects with
 *   `ChatRewindTimeoutError`. The chat stays marked running until `forget`
 *   settles. If it then succeeds, `cut` still runs: the harness has forgotten
 *   by then, and the transcript must match what the agent remembers.
 */
export function runChatRewind({
  sessionId,
  forget,
  cut,
  timeoutMs = CHAT_REWIND_TIMEOUT_MS,
}: {
  sessionId: string;
  forget: () => Promise<unknown>;
  cut: () => void;
  timeoutMs?: number;
}): Promise<void> {
  if (running.has(sessionId)) {
    return Promise.reject(new Error(CHAT_REWIND_RUNNING_MESSAGE));
  }
  running.add(sessionId);
  let work: Promise<void>;
  try {
    work = forget().then(() => cut());
  } catch (error) {
    running.delete(sessionId);
    return Promise.reject(error);
  }
  void work
    .finally(() => running.delete(sessionId))
    .catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ChatRewindTimeoutError(Math.round(timeoutMs / 1000))),
      timeoutMs,
    );
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** Test seam. */
export function __resetChatRewindRuns(): void {
  running.clear();
}
