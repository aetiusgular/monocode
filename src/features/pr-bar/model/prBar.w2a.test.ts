// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => false }));

import { CHECK_POLL_MS, PrBar } from "../ui/PrBar";
import {
  checksStateFor,
  prBarState,
  resetPrBarCache,
  savePrBarSettings,
  setPrBarHost,
  type PrChecksRead,
} from "./prBar";
import {
  resetOutboundCallsCache,
  setOutboundCallAllowed,
} from "../../settings/model/outboundCalls";
import type { GithubPrChecks } from "../../inbox/model/githubPrChecks";

// Mac 4.10 (16 Oct): GitHub's auto-merge merged PR #3, and the bar kept
// showing "#3 · 2 passed" and an Auto-merge switch for minutes. The checks
// read already said MERGED; the bar took its state from the PR lookup.
// Also J1 (Check now with lookups off) and G7 (gh timeouts) of the last
// security review.

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const PR = {
  number: 3,
  url: "https://github.com/aetiusgular/monocode-pr-test/pull/3",
  state: "open",
};
const REF = { repo: "aetiusgular/monocode-pr-test", number: 3 };
const TIMED_OUT = "gh did not answer in 60 s and was stopped. Check the network, then try again.";

const passed = (name: string) => ({
  name,
  workflow: "ci",
  state: "pass" as const,
  url: null,
  startedAt: null,
  completedAt: null,
});

function checks(patch: Partial<GithubPrChecks> = {}): GithubPrChecks {
  return {
    headOid: HEAD,
    checks: [passed("build"), passed("test")],
    number: 3,
    prId: "PR_kwDOQ7aZ3s6abcde",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    autoMergeRequest: { mergeMethod: "SQUASH" },
    ...patch,
  };
}
const merged = () =>
  checks({ state: "MERGED", autoMergeRequest: null, mergeStateStatus: "UNKNOWN" });

function read(
  patch: Partial<GithubPrChecks>,
  at: number | null = 2_000,
  number = 3,
): PrChecksRead {
  return { checks: checks(patch), number, at };
}

describe("prBarState: the newer of the PR lookup and the checks read", () => {
  it("checks read after the lookup say MERGED: the bar shows merged", () => {
    expect(
      prBarState({ number: 3, lookupState: "open", lookupAt: 1_000, read: read({ state: "MERGED" }) }),
    ).toBe("merged");
  });

  it("CLOSED read after the lookup: closed; a lookup newer than the read wins", () => {
    expect(
      prBarState({ number: 3, lookupState: "open", lookupAt: 1_000, read: read({ state: "CLOSED" }) }),
    ).toBe("closed");
    // Reopened since the read: the newer lookup says open.
    expect(
      prBarState({ number: 3, lookupState: "open", lookupAt: 3_000, read: read({ state: "CLOSED" }) }),
    ).toBe("open");
    expect(
      prBarState({ number: 3, lookupState: "closed", lookupAt: 1_000, read: read({ state: "OPEN" }) }),
    ).toBe("open");
  });

  it("checks say MERGED while a newer lookup says OPEN: merged stands", () => {
    // A merged PR never opens again, so a lagging answer cannot bring the
    // switches back.
    expect(
      prBarState({ number: 3, lookupState: "open", lookupAt: 9_000, read: read({ state: "MERGED" }) }),
    ).toBe("merged");
    expect(
      prBarState({ number: 3, lookupState: "merged", lookupAt: 1_000, read: read({ state: "OPEN" }) }),
    ).toBe("merged");
  });

  it("checks for another PR number say nothing about this one", () => {
    // GitHub's answer names another number.
    expect(checksStateFor(3, read({ state: "MERGED", number: 4 }))).toBeNull();
    expect(
      prBarState({ number: 3, lookupState: "open", lookupAt: 1_000, read: read({ state: "MERGED", number: 4 }) }),
    ).toBe("open");
    // The read asked for another number.
    expect(
      prBarState({ number: 3, lookupState: "open", lookupAt: 1_000, read: read({ state: "MERGED" }, 2_000, 4) }),
    ).toBe("open");
    // An answer that names no number: the number asked for decides.
    expect(checksStateFor(3, read({ state: "MERGED", number: null }))).toBe("merged");
  });

  it("a read with no state, or a word GitHub does not use for it, leaves the lookup's", () => {
    for (const state of [null, undefined, "", "DRAFT"]) {
      expect(
        prBarState({ number: 3, lookupState: "open", lookupAt: 1_000, read: read({ state }) }),
      ).toBe("open");
    }
    expect(
      prBarState({
        number: 3,
        lookupState: "Open",
        lookupAt: 1_000,
        read: { checks: null, number: null, at: null },
      }),
    ).toBe("open");
  });

  it("checks not read in this run do not outrank the lookup, except merged", () => {
    expect(
      prBarState({ number: 3, lookupState: "open", lookupAt: 1_000, read: read({ state: "CLOSED" }, null) }),
    ).toBe("open");
    expect(
      prBarState({ number: 3, lookupState: "open", lookupAt: 1_000, read: read({ state: "MERGED" }, null) }),
    ).toBe("merged");
  });

  it("a lookup with no answer time: the read decides", () => {
    expect(
      prBarState({ number: 3, lookupState: "open", lookupAt: null, read: read({ state: "CLOSED" }) }),
    ).toBe("closed");
  });
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetPrBarCache();
  resetOutboundCallsCache();
  invoke.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetOutboundCallsCache();
  setPrBarHost(null);
});

const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
async function render(props: Record<string, unknown>) {
  await act(async () => root.render(createElement(PrBar, { cwd: "/repo", pr: PR, ...props })));
  await settle();
}
const header = () => container.querySelector("[data-pr-bar] span.truncate")?.textContent ?? "";
const autoMerge = () => container.querySelector<HTMLButtonElement>('[aria-label="Auto-merge"]');
const switches = () => container.querySelectorAll('[role="switch"]');
const checkNow = () =>
  [...container.querySelectorAll("button")].find((button) => button.textContent === "Check now");

describe("4.10: the bar follows the state GitHub reports in the checks read", () => {
  it("auto-merge merged the PR: the next poll shows it merged, the switches go, and the lookup runs again", async () => {
    const reloadPr = vi.fn();
    invoke.mockResolvedValue(checks());
    await render({ checkedAt: 9_000, reloadPr });
    expect(header()).toContain("#3 · 2 passed");
    expect(autoMerge()?.getAttribute("aria-checked")).toBe("true");
    expect(reloadPr).not.toHaveBeenCalled();

    invoke.mockResolvedValue(merged());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECK_POLL_MS);
    });
    expect(header()).toContain("#3 · merged");
    expect(header()).not.toContain("2 passed");
    expect(autoMerge()).toBeNull();
    expect(switches()).toHaveLength(0);
    expect(reloadPr).toHaveBeenCalledTimes(1);

    // Nothing more is read or polled for a merged PR.
    const calls = invoke.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * CHECK_POLL_MS);
    });
    expect(invoke.mock.calls.length).toBe(calls);

    // The lookup catches up: still merged, and no second reload.
    await act(async () =>
      root.render(
        createElement(PrBar, { cwd: "/repo", pr: { ...PR, state: "merged" }, checkedAt: 20_000, reloadPr }),
      ),
    );
    expect(header()).toContain("#3 · merged");
    expect(reloadPr).toHaveBeenCalledTimes(1);
  });

  it("CLOSED: the bar shows closed, with no switches, and looks the PR up again", async () => {
    const reloadPr = vi.fn();
    invoke.mockResolvedValue(checks({ state: "CLOSED", autoMergeRequest: null }));
    await render({ checkedAt: 9_000, reloadPr });
    expect(header()).toContain("#3 · closed");
    expect(switches()).toHaveLength(0);
    expect(reloadPr).toHaveBeenCalledTimes(1);
  });

  it("checks say MERGED while the lookup says OPEN, even a newer lookup: merged, one reload", async () => {
    const reloadPr = vi.fn();
    invoke.mockResolvedValue(merged());
    await render({ checkedAt: 50_000, reloadPr });
    expect(header()).toContain("#3 · merged");
    expect(autoMerge()).toBeNull();
    expect(reloadPr).toHaveBeenCalledTimes(1);
    // The lookup answers open again, later still: the bar stays merged and
    // does not ask again, so two reads that disagree cannot loop.
    await act(async () =>
      root.render(createElement(PrBar, { cwd: "/repo", pr: PR, checkedAt: 60_000, reloadPr })),
    );
    await settle();
    expect(header()).toContain("#3 · merged");
    expect(reloadPr).toHaveBeenCalledTimes(1);
  });

  it("a CLOSED read older than the lookup: the newer lookup's open stands", async () => {
    const reloadPr = vi.fn();
    invoke.mockResolvedValue(checks({ state: "CLOSED", autoMergeRequest: null }));
    await render({ checkedAt: 50_000, reloadPr });
    expect(header()).toBe("#3 · 2 passed");
    // GitHub's read says closed, so auto-merge is not offered on it.
    expect(autoMerge()?.disabled).toBe(true);
    // The lookup still runs again, once, to settle it.
    expect(reloadPr).toHaveBeenCalledTimes(1);
  });

  it("checks for a different PR number do not change the bar", async () => {
    const reloadPr = vi.fn();
    invoke.mockResolvedValue(checks({ state: "MERGED", number: 4 }));
    await render({ checkedAt: 9_000, reloadPr });
    expect(header()).toContain("#3 · 2 passed");
    expect(header()).not.toContain("merged");
    expect(reloadPr).not.toHaveBeenCalled();
  });

  it("the lookup already says merged: no reload", async () => {
    const reloadPr = vi.fn();
    await render({ pr: { ...PR, state: "merged" }, initialChecks: merged(), reloadPr });
    expect(header()).toContain("#3 · merged");
    expect(reloadPr).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("archives the chat when the checks read says merged, with the switch on", async () => {
    const archiveSession = vi.fn(async () => {});
    setPrBarHost({ submitRepair: vi.fn(async () => true), archiveSession });
    savePrBarSettings(REF, { autoArchive: true });
    invoke.mockResolvedValue(merged());
    await render({
      checkedAt: 9_000,
      owner: { kind: "route", harness: "codex", sessionId: "s1", modelId: "codex:qwen2.5:7b" },
    });
    expect(archiveSession).toHaveBeenCalledTimes(1);
    expect(archiveSession).toHaveBeenCalledWith("s1");
  });
});

describe("J1: Check now with GitHub lookups off", () => {
  it("reads the checks and runs one PR lookup; the switches unlock once a lookup confirms the PR", async () => {
    setOutboundCallAllowed("github-lookups", false);
    const reloadPr = vi.fn();
    invoke.mockResolvedValue(checks({ autoMergeRequest: null }));
    await render({ confirmed: false, reloadPr });
    expect(invoke).not.toHaveBeenCalled();
    expect(reloadPr).not.toHaveBeenCalled();

    await act(async () => checkNow()!.click());
    await settle();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("git_github_pr_checks", {
      cwd: "/repo",
      repo: REF.repo,
      number: 3,
    });
    expect(reloadPr).toHaveBeenCalledTimes(1);
    // The read alone does not unlock them, as built (G4).
    expect(autoMerge()?.disabled).toBe(true);

    // The lookup it ran confirmed the PR.
    await act(async () =>
      root.render(createElement(PrBar, { cwd: "/repo", pr: PR, confirmed: true, reloadPr })),
    );
    expect(autoMerge()?.disabled).toBe(false);

    // And nothing runs on its own afterwards.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * CHECK_POLL_MS);
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(reloadPr).toHaveBeenCalledTimes(1);
  });

  it("without the reload path the bar still reads the checks", async () => {
    setOutboundCallAllowed("github-lookups", false);
    invoke.mockResolvedValue(checks());
    await render({ confirmed: false });
    await act(async () => checkNow()!.click());
    await settle();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("G7: a gh call that times out", () => {
  it("a checks read that times out shows an error and keeps the PR", async () => {
    invoke.mockResolvedValue(checks());
    await render({ checkedAt: 9_000 });
    invoke.mockRejectedValue(TIMED_OUT.replace("60", "30"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECK_POLL_MS);
    });
    expect(header()).toBe(
      "#3 · Checks failed to load, showing saved results that may be out of date: 2 passed",
    );
    expect(header()).not.toContain("merged");
  });

  it("a mutation that times out leaves the switch usable and says why", async () => {
    invoke.mockResolvedValue(checks({ autoMergeRequest: null }));
    await render({ checkedAt: 9_000 });
    expect(autoMerge()?.getAttribute("aria-checked")).toBe("false");
    invoke.mockImplementation(async (command: string) =>
      command === "git_github_pr_auto_merge"
        ? { refusal: TIMED_OUT, pr: checks({ autoMergeRequest: null }) }
        : checks({ autoMergeRequest: null }),
    );
    await act(async () => autoMerge()!.click());
    await settle();
    expect(container.textContent).toContain(TIMED_OUT);
    expect(autoMerge()?.disabled).toBe(false);
    expect(autoMerge()?.getAttribute("aria-checked")).toBe("false");
  });

  it("a read before the mutation that times out: nothing changes, the switch stays usable, the bar reads again", async () => {
    invoke.mockResolvedValue(checks({ autoMergeRequest: null }));
    await render({ checkedAt: 9_000 });
    const timedOutRead = TIMED_OUT.replace("60", "30");
    invoke.mockImplementation(async (command: string) =>
      command === "git_github_pr_auto_merge"
        ? { readError: timedOutRead }
        : checks({ autoMergeRequest: null }),
    );
    await act(async () => autoMerge()!.click());
    await settle();
    expect(container.textContent).toContain(`Could not read the PR again: ${timedOutRead}`);
    expect(autoMerge()?.disabled).toBe(false);
    expect(invoke.mock.calls.filter(([command]) => command === "git_github_pr_checks").length).toBe(2);
  });

  it("a command that fails outright leaves the switch usable", async () => {
    invoke.mockResolvedValue(checks({ autoMergeRequest: null }));
    await render({ checkedAt: 9_000 });
    invoke.mockImplementation(async (command: string) => {
      if (command === "git_github_pr_auto_merge") throw TIMED_OUT;
      return checks({ autoMergeRequest: null });
    });
    await act(async () => autoMerge()!.click());
    await settle();
    expect(container.textContent).toContain(`Could not change auto-merge: ${TIMED_OUT}`);
    expect(autoMerge()?.disabled).toBe(false);
  });
});
