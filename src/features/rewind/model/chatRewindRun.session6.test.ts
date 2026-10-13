import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_REWIND_RUNNING_MESSAGE,
  CHAT_REWIND_TIMEOUT_MS,
  ChatRewindTimeoutError,
  __resetChatRewindRuns,
  chatRewindRunning,
  runChatRewind,
} from "./chatRewindRun";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  __resetChatRewindRuns();
});

afterEach(() => {
  vi.useRealTimers();
  __resetChatRewindRuns();
});

describe("runChatRewind", () => {
  it("cuts only after the harness has forgotten", async () => {
    const order: string[] = [];
    const harness = deferred();
    const cut = vi.fn(() => order.push("cut"));
    const done = runChatRewind({
      sessionId: "s1",
      forget: () => {
        order.push("forget");
        return harness.promise;
      },
      cut,
    });
    await Promise.resolve();
    expect(cut).not.toHaveBeenCalled();
    expect(chatRewindRunning("s1")).toBe(true);
    harness.resolve();
    await done;
    expect(order).toEqual(["forget", "cut"]);
    expect(chatRewindRunning("s1")).toBe(false);
  });

  it("leaves the transcript alone and rethrows when the harness refuses", async () => {
    const cut = vi.fn();
    await expect(
      runChatRewind({
        sessionId: "s1",
        forget: async () => {
          throw new Error("Claude Code could not go back to before this message");
        },
        cut,
      }),
    ).rejects.toThrow("Claude Code could not go back to before this message");
    expect(cut).not.toHaveBeenCalled();
    expect(chatRewindRunning("s1")).toBe(false);
  });

  it("rejects a harness call that throws synchronously and frees the chat", async () => {
    const cut = vi.fn();
    await expect(
      runChatRewind({
        sessionId: "s1",
        forget: () => {
          throw new Error("No harness adapter registered");
        },
        cut,
      }),
    ).rejects.toThrow("No harness adapter registered");
    expect(cut).not.toHaveBeenCalled();
    expect(chatRewindRunning("s1")).toBe(false);
  });

  it("gives up with an error when the harness never answers, and does not cut", async () => {
    vi.useFakeTimers();
    const cut = vi.fn();
    const done = runChatRewind({
      sessionId: "s1",
      forget: () => new Promise(() => undefined),
      cut,
    });
    const settled = done.then(
      () => "resolved",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(CHAT_REWIND_TIMEOUT_MS - 1);
    expect(chatRewindRunning("s1")).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await settled;
    expect(outcome).toBeInstanceOf(ChatRewindTimeoutError);
    expect((outcome as Error).message).toContain("within 45 s");
    expect(cut).not.toHaveBeenCalled();
    // The harness call is still out: the chat stays busy, so a retry cannot
    // start a second restart on top of it.
    expect(chatRewindRunning("s1")).toBe(true);
  });

  it("refuses a second press while one runs, rather than queueing it", async () => {
    const harness = deferred();
    const forget = vi.fn(() => harness.promise);
    const cut = vi.fn();
    const first = runChatRewind({ sessionId: "s1", forget, cut });
    await expect(
      runChatRewind({ sessionId: "s1", forget, cut }),
    ).rejects.toThrow(CHAT_REWIND_RUNNING_MESSAGE);
    expect(forget).toHaveBeenCalledTimes(1);
    harness.resolve();
    await first;
    expect(cut).toHaveBeenCalledTimes(1);
    // Once the first has settled the chat can be rewound again.
    await runChatRewind({ sessionId: "s1", forget: async () => undefined, cut });
    expect(cut).toHaveBeenCalledTimes(2);
  });

  it("does not block another chat", async () => {
    const harness = deferred();
    const first = runChatRewind({
      sessionId: "s1",
      forget: () => harness.promise,
      cut: () => undefined,
    });
    await expect(
      runChatRewind({
        sessionId: "s2",
        forget: async () => undefined,
        cut: () => undefined,
      }),
    ).resolves.toBeUndefined();
    harness.resolve();
    await first;
  });

  it("still cuts when the harness forgets after the menu gave up", async () => {
    vi.useFakeTimers();
    const harness = deferred();
    const cut = vi.fn();
    const done = runChatRewind({
      sessionId: "s1",
      forget: () => harness.promise,
      cut,
      timeoutMs: 1_000,
    });
    const settled = done.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await settled).toBeInstanceOf(ChatRewindTimeoutError);
    expect(cut).not.toHaveBeenCalled();
    // The agent has now forgotten: the transcript must follow it.
    harness.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(cut).toHaveBeenCalledTimes(1);
    expect(chatRewindRunning("s1")).toBe(false);
  });
});
