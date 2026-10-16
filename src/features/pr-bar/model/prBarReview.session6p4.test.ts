// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => false }));

import { PrBar } from "../ui/PrBar";
import { autoMergeView, decideAutoFix, resetPrBarCache } from "./prBar";
import {
  resetOutboundCallsCache,
  setOutboundCallAllowed,
} from "../../settings/model/outboundCalls";
import {
  cachedPrLookupState,
  PR_STATUS_KEY,
  resetPrLookupMemory,
} from "../../source-control/model/prLookup";
import type { GithubPrChecks } from "../../inbox/model/githubPrChecks";

// The security review of the 15 Oct fix pass (G2, G3, G4).

const PR = {
  number: 1,
  title: "Add a retest line to the README",
  url: "https://github.com/aetiusgular/monocode-pr-test/pull/1",
  state: "open",
};
const CHECKS: GithubPrChecks = {
  headOid: "0123456789abcdef0123456789abcdef01234567",
  checks: [],
  prId: "PR_kwDOQ7aZ3s6abcde",
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  autoMergeRequest: { mergeMethod: "SQUASH" },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  resetPrBarCache();
  resetOutboundCallsCache();
  resetPrLookupMemory();
  invoke.mockReset();
  invoke.mockResolvedValue(CHECKS);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  resetOutboundCallsCache();
});

describe("G2: with GitHub lookups off the bar reads nothing on its own", () => {
  it("no read at mount and no poll, until Check now", async () => {
    vi.useFakeTimers();
    setOutboundCallAllowed("github-lookups", false);
    await act(async () => root.render(createElement(PrBar, { cwd: "/repo", pr: PR })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(invoke).not.toHaveBeenCalled();
    const check = [...container.querySelectorAll("button")].find((b) => b.textContent === "Check now")!;
    await act(async () => check.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("git_github_pr_checks", expect.anything());
    // Auto-merge is on (from GitHub), and still no poll with lookups off.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("with lookups on, the bar reads once at mount and polls while auto-merge is on", async () => {
    vi.useFakeTimers();
    await act(async () => root.render(createElement(PrBar, { cwd: "/repo", pr: PR })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Check now");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(invoke.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("G4: switches stay off until a lookup in this run confirms the PR", () => {
  it("a cached PR shows with every switch off", () => {
    const html = renderToStaticMarkup(
      createElement(PrBar, {
        cwd: "/repo",
        pr: PR,
        confirmed: false,
        initialChecks: { ...CHECKS, autoMergeRequest: null },
        owner: { kind: "route", harness: "codex", sessionId: "s1", modelId: "codex:qwen2.5:7b" },
      }),
    );
    for (const label of ["Auto-merge", "Auto-fix failed checks", "Archive the chat when merged or closed"]) {
      expect(html).toMatch(new RegExp(`aria-label="${label}" aria-checked="[a-z]+" disabled=""`));
    }
  });
});

describe("G3: the PR cache keeps only github.com pull request addresses", () => {
  it("drops any other https address", () => {
    localStorage.setItem(
      PR_STATUS_KEY,
      JSON.stringify([
        ["/r\nb", { pr: { ...PR, url: "https://evil.example/aetiusgular/monocode-pr-test/pull/1" }, checkedAt: 1 }],
        ["/r\nc", { pr: { ...PR, url: "https://github.com/aetiusgular/monocode-pr-test/issues/1" }, checkedAt: 1 }],
        ["/r\nd", { pr: PR, checkedAt: 1 }],
      ]),
    );
    resetPrLookupMemory();
    expect(cachedPrLookupState("/r", "b").pr).toBeNull();
    expect(cachedPrLookupState("/r", "c").pr).toBeNull();
    expect(cachedPrLookupState("/r", "d").pr).toEqual(PR);
  });
});

describe("H1: a PR GitHub reports closed gets no repair and no auto-merge", () => {
  it("decideAutoFix and autoMergeView read GitHub's state", () => {
    const failed = { name: "check", workflow: "ci", state: "fail" as const, url: null, startedAt: null, completedAt: null };
    const settings = { autoFix: true, autoArchive: false, fixAttempts: 0 };
    const open = { ...CHECKS, autoMergeRequest: null, checks: [failed] };
    expect(decideAutoFix({ settings, checks: open, hasChat: true }).send).toBe(true);
    for (const state of ["CLOSED", "MERGED"]) {
      expect(decideAutoFix({ settings, checks: { ...open, state }, hasChat: true })).toEqual({
        send: false,
        reason: "not-open",
      });
      expect(autoMergeView({ ...open, state })).toEqual({ kind: "unknown" });
    }
  });
});
