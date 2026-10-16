// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Changes panel hands the PR bar its lookup's reload: Mac 4.10 (16 Oct),
// a merged PR showed as open, and J1, Check now with "GitHub lookups" off.

const invoke = vi.hoisted(() => vi.fn());
const gitPrStatus = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => false }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("../../../platform/tauri/fs", () => ({
  gitDiffIndex: vi.fn(async () => ({
    branch: "s7r2-pr3",
    head: "abc123",
    files: [],
    additions: 0,
    deletions: 0,
    remote: "origin",
    upstream: "origin/s7r2-pr3",
    defaultBranch: "main",
    ahead: 0,
    behind: 0,
    aheadOfDefault: 1,
    headPushed: true,
  })),
  gitHistory: vi.fn(async () => []),
  gitPrStatus,
  gitPull: vi.fn(async () => {}),
  gitPush: vi.fn(async () => {}),
  gitSync: vi.fn(async () => {}),
  gitCommit: vi.fn(async () => {}),
  gitHeadMessage: vi.fn(async () => ""),
  gitStageAll: vi.fn(async () => {}),
  gitUnstageAll: vi.fn(async () => {}),
  gitDiscardAll: vi.fn(async () => {}),
  gitStageFile: vi.fn(async () => {}),
  gitUnstageFile: vi.fn(async () => {}),
  gitDiscardFile: vi.fn(async () => {}),
  gitPrCreate: vi.fn(async () => ""),
  gitRangeContext: vi.fn(),
  notifyGitChanged: vi.fn(),
  subscribeGitChanged: () => () => {},
  basename: (path: string) => path.split("/").pop() ?? path,
}));
vi.mock("../../../integrations/harness", () => ({
  generateCommitMessage: vi.fn(async () => ""),
  generatePrContent: vi.fn(async () => null),
}));
vi.mock("../../files/model/fileWatch", () => ({
  invalidateWatchedFiles: vi.fn(),
  nudgeWatchedFiles: vi.fn(),
}));
vi.mock("../../inbox/model/inboxSelfActivity", () => ({
  recordInboxSelfActivity: vi.fn(),
}));

import { GitChangesPanel } from "./GitChangesPanel";
import { resetPrLookupMemory } from "../model/prLookup";
import { resetPrBarCache } from "../../pr-bar/model/prBar";
import {
  resetOutboundCallsCache,
  setOutboundCallAllowed,
} from "../../settings/model/outboundCalls";
import type { GithubPrChecks } from "../../inbox/model/githubPrChecks";

const PR = {
  number: 3,
  title: "Add a retest line to the README",
  url: "https://github.com/aetiusgular/monocode-pr-test/pull/3",
  state: "open",
};
const CHECKS: GithubPrChecks = {
  headOid: "0123456789abcdef0123456789abcdef01234567",
  checks: [
    { name: "build", workflow: "ci", state: "pass", url: null, startedAt: null, completedAt: null },
    { name: "test", workflow: "ci", state: "pass", url: null, startedAt: null, completedAt: null },
  ],
  number: 3,
  prId: "PR_kwDOQ7aZ3s6abcde",
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  autoMergeRequest: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  localStorage.clear();
  resetPrLookupMemory();
  resetPrBarCache();
  resetOutboundCallsCache();
  invoke.mockReset();
  gitPrStatus.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.clearAllTimers();
  vi.useRealTimers();
  container.remove();
  vi.unstubAllGlobals();
  resetOutboundCallsCache();
});

const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
async function renderPanel() {
  act(() =>
    root.render(
      createElement(GitChangesPanel, {
        cwd: "/Users/t/s7r2-prtest",
        enabled: true,
        onOpenFile: vi.fn(),
        onOpenAllChanges: vi.fn(),
        onOpenCommit: vi.fn(),
      }),
    ),
  );
  await settle();
  await settle();
}
const header = () => container.querySelector("[data-pr-bar] span.truncate")?.textContent ?? "";
const autoMerge = () => container.querySelector<HTMLButtonElement>('[aria-label="Auto-merge"]');
const checksReads = () => invoke.mock.calls.filter(([command]) => command === "git_github_pr_checks");

describe("the panel and the PR bar", () => {
  it("4.10: checks that say MERGED make the panel look the PR up again, and the bar shows merged", async () => {
    gitPrStatus.mockResolvedValue(PR);
    invoke.mockImplementation(async (command: string) =>
      command === "git_github_pr_checks" ? { ...CHECKS, state: "MERGED" } : undefined,
    );
    await renderPanel();
    expect(gitPrStatus).toHaveBeenCalledTimes(2);
    expect(header()).toBe("#3 · merged");
    expect(autoMerge()).toBeNull();
  });

  it("J1: with lookups off, Check now reads the checks and runs one lookup, which unlocks the switch", async () => {
    // A PR this folder and branch had before, from an earlier run.
    gitPrStatus.mockResolvedValue(PR);
    invoke.mockImplementation(async (command: string) =>
      command === "git_github_pr_checks" ? CHECKS : undefined,
    );
    await renderPanel();
    act(() => root.unmount());
    root = createRoot(container);
    gitPrStatus.mockClear();
    invoke.mockClear();
    setOutboundCallAllowed("github-lookups", false);

    await renderPanel();
    expect(gitPrStatus).not.toHaveBeenCalled();
    expect(checksReads()).toHaveLength(0);
    expect(header()).toContain("#3");

    const checkNow = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Check now",
    )!;
    await act(async () => checkNow.click());
    await settle();
    await settle();
    expect(gitPrStatus).toHaveBeenCalledTimes(1);
    expect(checksReads()).toHaveLength(1);
    expect(header()).toBe("#3 · 2 passed");
    expect(autoMerge()?.disabled).toBe(false);

    // Nothing runs on its own afterwards: no focus lookup, no poll.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(gitPrStatus).toHaveBeenCalledTimes(1);
    expect(checksReads()).toHaveLength(1);
  });
});
