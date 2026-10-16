// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrLookup, resetPrLookupMemory, type PrLookupState } from "./prLookup";
import type { GitPr } from "../../../platform/tauri/fs";

// J1 and G7 of the last security review: Check now with "GitHub lookups" off
// runs one lookup and turns nothing on, and a gh call that times out is a
// failed lookup that keeps the last known PR.

const PR: GitPr = {
  number: 3,
  title: "Add a retest line to the README",
  url: "https://github.com/aetiusgular/monocode-pr-test/pull/3",
  state: "open",
};
const CWD = "/Users/t/s7r2-prtest";
const TIMED_OUT =
  "gh did not answer in 30 s and was stopped. Check the network, then try again.";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  localStorage.clear();
  resetPrLookupMemory();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a lookup the user asked for (J1)", () => {
  it("runs once with lookups off, where run asks nothing", async () => {
    const fetch = vi.fn(async () => PR);
    const states: PrLookupState[] = [];
    const lookup = createPrLookup({
      cwd: CWD,
      branch: "s7r2-pr3",
      fetch,
      onChange: (state) => states.push(state),
      allowed: () => false,
      now: () => 500,
    });
    lookup.run();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    lookup.ask();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(states[states.length - 1]).toEqual({ pr: PR, answered: true, stale: false, checkedAt: 500 });
    // A focus afterwards asks nothing.
    lookup.run();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    lookup.dispose();
  });

  // Changed for K7: this asserted that the 5, 15 and 45 s retries ran with
  // lookups off. Now a lookup you ask for with lookups off runs once, and a
  // failure waits for you to ask again.
  it("with lookups off, a failure is not retried, and a focus that may not ask asks nothing", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (): Promise<GitPr | null> => {
      throw new Error("dial tcp: lookup api.github.com: no such host");
    });
    const lookup = createPrLookup({
      cwd: CWD,
      branch: "s7r2-pr3",
      fetch,
      onChange: () => {},
      allowed: () => false,
    });
    lookup.ask();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    lookup.run();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000 + 45_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    // Asking again runs one more, and again no retry.
    lookup.ask();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    lookup.dispose();
  });

  it("with lookups on, a focus replaces a pending retry and asks now", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return PR;
    });
    const lookup = createPrLookup({
      cwd: CWD,
      branch: "s7r2-pr3",
      fetch,
      onChange: () => {},
      allowed: () => true,
    });
    lookup.ask();
    await vi.advanceTimersByTimeAsync(0);
    lookup.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    lookup.dispose();
  });
});

describe("a lookup that times out (G7)", () => {
  it("keeps the last known PR, marked stale, with when it was last checked", async () => {
    let timedOut = false;
    const fetch = vi.fn(async () => {
      if (timedOut) throw TIMED_OUT;
      return PR;
    });
    const states: PrLookupState[] = [];
    const lookup = createPrLookup({
      cwd: CWD,
      branch: "s7r2-pr3",
      fetch,
      onChange: (state) => states.push(state),
      now: () => 1_000,
    });
    lookup.run();
    await flush();
    timedOut = true;
    lookup.run();
    await flush();
    // Not "no PR": Create PR stays hidden, and the bar says "last checked".
    expect(states[states.length - 1]).toEqual({ pr: PR, answered: false, stale: true, checkedAt: 1_000 });
    lookup.dispose();
  });
});
