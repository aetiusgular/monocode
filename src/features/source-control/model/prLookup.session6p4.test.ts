// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cachedPrLookupState,
  createPrLookup,
  lastCheckedText,
  PR_RETRY_DELAYS_MS,
  PR_STATUS_KEY,
  resetPrLookupMemory,
  type PrLookupState,
} from "./prLookup";
import type { GitPr } from "../../../platform/tauri/fs";

// Mac test 4.10, retest 3: after opening the tab, a reload or a push, Create
// PR showed for 1 to 3 minutes on a branch with an open PR. The first gh call
// after idle failed on the Mac's DNS, and the failure read as "no PR".

const PR: GitPr = {
  number: 1,
  title: "Add a retest line to the README",
  url: "https://github.com/aetiusgular/monocode-pr-test/pull/1",
  state: "open",
};
const CWD = "/Users/t/s7r2-prtest";

function track() {
  const states: PrLookupState[] = [];
  return { states, onChange: (state: PrLookupState) => states.push(state) };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  localStorage.clear();
  resetPrLookupMemory();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a failed lookup keeps the last known PR", () => {
  it("keeps the bar, marks it stale, and keeps when it was last checked", async () => {
    let fail = false;
    const fetch = vi.fn(async () => {
      if (fail) throw new Error("Could not resolve host: github.com");
      return PR;
    });
    const { states, onChange } = track();
    const lookup = createPrLookup({ cwd: CWD, branch: "s7r2-pr1", fetch, onChange, now: () => 1000 });
    lookup.run();
    await flush();
    expect(states.at(-1)).toEqual({ pr: PR, answered: true, stale: false, checkedAt: 1000 });
    fail = true;
    lookup.run();
    await flush();
    expect(states.at(-1)).toEqual({ pr: PR, answered: false, stale: true, checkedAt: 1000 });
    lookup.dispose();
  });

  it("an answer of no PR is a result: the PR goes, and Create PR may show", async () => {
    let answer: GitPr | null = PR;
    const { states, onChange } = track();
    const lookup = createPrLookup({ cwd: CWD, branch: "s7r2-pr1", fetch: async () => answer, onChange });
    lookup.run();
    await flush();
    answer = null;
    lookup.run();
    await flush();
    expect(states.at(-1)).toMatchObject({ pr: null, answered: true, stale: false });
    lookup.dispose();
  });
});

describe("retries", () => {
  it("retries at 5 s, 15 s and 45 s, then waits for the normal poll", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (): Promise<GitPr | null> => {
      throw new Error("dial tcp: lookup api.github.com: no such host");
    });
    const lookup = createPrLookup({ cwd: CWD, branch: "s7r2-pr1", fetch, onChange: () => {} });
    expect(PR_RETRY_DELAYS_MS).toEqual([5_000, 15_000, 45_000]);
    lookup.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(fetch).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(4);
    // The normal poll (focus, a git action) still asks.
    lookup.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(5);
    lookup.dispose();
  });

  it("a retry that answers ends the stale state", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("timeout");
      return PR;
    });
    const { states, onChange } = track();
    const lookup = createPrLookup({ cwd: CWD, branch: "s7r2-pr1", fetch, onChange, now: () => 7 });
    lookup.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toMatchObject({ stale: true, answered: false });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(states.at(-1)).toEqual({ pr: PR, answered: true, stale: false, checkedAt: 7 });
    lookup.dispose();
  });

  it("no retry runs after the panel closed", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (): Promise<GitPr | null> => {
      throw new Error("offline");
    });
    const lookup = createPrLookup({ cwd: CWD, branch: "s7r2-pr1", fetch, onChange: () => {} });
    lookup.run();
    await vi.advanceTimersByTimeAsync(0);
    lookup.dispose();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("asks nothing while GitHub lookups are off", async () => {
    const fetch = vi.fn(async () => PR);
    const lookup = createPrLookup({ cwd: CWD, branch: "s7r2-pr1", fetch, onChange: () => {}, allowed: () => false });
    lookup.run();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the last answer survives a reload", () => {
  it("a reload shows the cached PR for that folder and branch before any lookup", async () => {
    const lookup = createPrLookup({ cwd: CWD, branch: "s7r2-pr1", fetch: async () => PR, onChange: () => {}, now: () => 1234 });
    lookup.run();
    await flush();
    lookup.dispose();
    resetPrLookupMemory();
    expect(cachedPrLookupState(CWD, "s7r2-pr1")).toEqual({
      pr: PR,
      answered: false,
      stale: false,
      checkedAt: 1234,
    });
    // Another branch of the same folder has its own entry.
    expect(cachedPrLookupState(CWD, "main").pr).toBeNull();
  });

  it("reads only web addresses back from storage", () => {
    localStorage.setItem(
      PR_STATUS_KEY,
      JSON.stringify([
        [`${CWD}\ns7r2-pr1`, { pr: { ...PR, url: "file:///etc/passwd" }, checkedAt: 1 }],
        [`${CWD}\nother`, { pr: PR, checkedAt: 2 }],
      ]),
    );
    resetPrLookupMemory();
    expect(cachedPrLookupState(CWD, "s7r2-pr1").pr).toBeNull();
    expect(cachedPrLookupState(CWD, "other").pr).toEqual(PR);
  });
});

it("says when it last checked", () => {
  expect(lastCheckedText(null)).toBe("not checked yet");
  expect(lastCheckedText(Date.UTC(2026, 9, 15, 17, 42))).toMatch(/^last checked \d{1,2}:42/);
});
