// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPrLookup,
  lastCheckedText,
  lookupFailedText,
  resetPrLookupMemory,
  type PrLookupState,
} from "./prLookup";
import type { GitPr } from "../../../platform/tauri/fs";

// K7 of the security review: with "GitHub lookups" off, a lookup you ask for
// runs once. Retries are calls nobody asked for, so they run only with
// lookups on.

const PR: GitPr = {
  number: 3,
  title: "Add a retest line to the README",
  url: "https://github.com/aetiusgular/monocode-pr-test/pull/3",
  state: "open",
};
const CWD = "/Users/t/s7r2-prtest";
const offline = vi.fn(async (): Promise<GitPr | null> => {
  throw new Error("dial tcp: lookup api.github.com: no such host");
});

beforeEach(() => {
  localStorage.clear();
  resetPrLookupMemory();
  offline.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a lookup you ask for", () => {
  it("lookups off: one call, no retry after 60 s, and the last known PR stays, stale", async () => {
    // The PR an earlier lookup found.
    const first = createPrLookup({ cwd: CWD, branch: "s7r2-pr3", fetch: async () => PR, onChange: () => {}, now: () => 500 });
    first.run();
    await vi.advanceTimersByTimeAsync(0);
    first.dispose();

    const states: PrLookupState[] = [];
    const lookup = createPrLookup({
      cwd: CWD,
      branch: "s7r2-pr3",
      fetch: offline,
      onChange: (state) => states.push(state),
      allowed: () => false,
    });
    lookup.ask();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(offline).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toEqual({ pr: PR, answered: false, stale: true, checkedAt: 500 });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(offline).toHaveBeenCalledTimes(1);
    lookup.dispose();
  });

  it("lookups on: a failure still retries at 5, 15 and 45 s", async () => {
    const lookup = createPrLookup({
      cwd: CWD,
      branch: "s7r2-pr3",
      fetch: offline,
      onChange: () => {},
      allowed: () => true,
    });
    lookup.ask();
    await vi.advanceTimersByTimeAsync(0);
    expect(offline).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(offline).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(offline).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(offline).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(offline).toHaveBeenCalledTimes(4);
    lookup.dispose();
  });

  it("lookups turned off while a retry waits: the retry does not run", async () => {
    let on = true;
    const lookup = createPrLookup({
      cwd: CWD,
      branch: "s7r2-pr3",
      fetch: offline,
      onChange: () => {},
      allowed: () => on,
    });
    lookup.ask();
    await vi.advanceTimersByTimeAsync(0);
    on = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(offline).toHaveBeenCalledTimes(1);
    lookup.dispose();
  });
});

it("says the lookup failed, then when it last checked", () => {
  expect(lookupFailedText(null)).toBe("lookup failed, not checked yet");
  const at = Date.UTC(2026, 9, 16, 17, 42);
  expect(lookupFailedText(at)).toBe(`lookup failed, ${lastCheckedText(at)}`);
});
