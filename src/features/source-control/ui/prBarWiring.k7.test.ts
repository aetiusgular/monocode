// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// K7 of the security review: with "GitHub lookups" off, one Check now led to
// a checks read, a lookup retried at 5, 15 and 45 s, a second lookup when the
// read said merged, and another read when the PR address changed. Now one
// Check now is one checks read and one lookup, and nothing follows on its own.

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

import { GitChangesPanel, usePrStatus, type PrStatus } from "./GitChangesPanel";
import { resetPrLookupMemory } from "../model/prLookup";
import { resetPrBarCache } from "../../pr-bar/model/prBar";
import {
  resetOutboundCallsCache,
  setOutboundCallAllowed,
} from "../../settings/model/outboundCalls";
import type { GithubPrChecks } from "../../inbox/model/githubPrChecks";

const CWD = "/Users/t/s7r2-prtest";
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
const OFFLINE = "dial tcp: lookup api.github.com: no such host";

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
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
async function renderPanel() {
  act(() =>
    root.render(
      createElement(GitChangesPanel, {
        cwd: CWD,
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
const checkNow = () =>
  [...container.querySelectorAll("button")].find((button) => button.textContent === "Check now");
const checksReads = () => invoke.mock.calls.filter(([command]) => command === "git_github_pr_checks");
/** Every gh call the panel made: PR lookups plus anything sent to GitHub through invoke. */
const githubCalls = () =>
  gitPrStatus.mock.calls.length +
  invoke.mock.calls.filter(([command]) => String(command).includes("github")).length;

/** A PR this folder and branch had in an earlier run, then lookups off. */
async function cachedPrWithLookupsOff(checks: GithubPrChecks) {
  gitPrStatus.mockResolvedValue(PR);
  invoke.mockImplementation(async (command: string) =>
    command === "git_github_pr_checks" ? CHECKS : undefined,
  );
  await renderPanel();
  act(() => root.unmount());
  root = createRoot(container);
  gitPrStatus.mockReset();
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) =>
    command === "git_github_pr_checks" ? checks : undefined,
  );
  setOutboundCallAllowed("github-lookups", false);
  await renderPanel();
  expect(githubCalls()).toBe(0);
  expect(header()).toContain("#3");
}

describe("K7: with GitHub lookups off, Check now is one read and one lookup", () => {
  it("a failed lookup is not retried, even after 60 s; the bar says it failed and offers Check now again", async () => {
    await cachedPrWithLookupsOff(CHECKS);
    gitPrStatus.mockRejectedValue(OFFLINE);

    await act(async () => checkNow()!.click());
    await settle();
    await settle();
    expect(checksReads()).toHaveLength(1);
    expect(gitPrStatus).toHaveBeenCalledTimes(1);
    expect(githubCalls()).toBe(2);

    await wait(60_000);
    expect(gitPrStatus).toHaveBeenCalledTimes(1);
    expect(checksReads()).toHaveLength(1);
    await wait(10 * 60_000);
    expect(githubCalls()).toBe(2);

    // It says so, in the bar's "last checked" style, and Check now is there.
    expect(header()).toMatch(/^#3 · 2 passed · lookup failed, last checked /);
    expect(container.querySelector("[data-pr-lookup-stale]")?.className).toContain("text-amber-400");
    expect(checkNow()).toBeDefined();
    // Not confirmed, so the switch stays off.
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Auto-merge"]')?.disabled).toBe(true);

    // Asking again: one more of each, and the switch unlocks when it answers.
    gitPrStatus.mockResolvedValue(PR);
    await act(async () => checkNow()!.click());
    await settle();
    await settle();
    expect(checksReads()).toHaveLength(2);
    expect(gitPrStatus).toHaveBeenCalledTimes(2);
    expect(header()).toBe("#3 · 2 passed");
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Auto-merge"]')?.disabled).toBe(false);
    await wait(10 * 60_000);
    expect(githubCalls()).toBe(4);
  });

  it("a read that says MERGED shows merged and runs no second lookup", async () => {
    await cachedPrWithLookupsOff({ ...CHECKS, state: "MERGED" });
    // The lookup Check now runs still says open, as a lagging one would.
    gitPrStatus.mockResolvedValue(PR);

    await act(async () => checkNow()!.click());
    await settle();
    await settle();
    expect(header()).toBe("#3 · merged");
    expect(checksReads()).toHaveLength(1);
    expect(gitPrStatus).toHaveBeenCalledTimes(1);

    await wait(10 * 60_000);
    expect(gitPrStatus).toHaveBeenCalledTimes(1);
    expect(checksReads()).toHaveLength(1);
    expect(githubCalls()).toBe(2);
    expect(header()).toBe("#3 · merged");
  });

  it("a lookup that finds a new PR address does not read its checks on its own", async () => {
    await cachedPrWithLookupsOff(CHECKS);
    const next = { ...PR, number: 4, url: "https://github.com/aetiusgular/monocode-pr-test/pull/4" };
    gitPrStatus.mockResolvedValue(next);

    await act(async () => checkNow()!.click());
    await settle();
    await settle();
    expect(header()).toContain("#4");
    expect(checksReads()).toHaveLength(1);
    expect(gitPrStatus).toHaveBeenCalledTimes(1);
    await wait(10 * 60_000);
    expect(githubCalls()).toBe(2);
  });
});

describe("K7: with GitHub lookups on, nothing changes", () => {
  it("a failed lookup still retries at 5, 15 and 45 s", async () => {
    gitPrStatus.mockResolvedValue(PR);
    invoke.mockImplementation(async (command: string) =>
      command === "git_github_pr_checks" ? CHECKS : undefined,
    );
    await renderPanel();
    act(() => root.unmount());
    root = createRoot(container);
    gitPrStatus.mockReset();
    gitPrStatus.mockRejectedValue(OFFLINE);

    await renderPanel();
    expect(gitPrStatus).toHaveBeenCalledTimes(1);
    // Retries pending: the bar says when it last checked, not that it failed.
    expect(header()).toContain("last checked");
    expect(header()).not.toContain("lookup failed");
    await wait(5_000);
    expect(gitPrStatus).toHaveBeenCalledTimes(2);
    await wait(15_000);
    expect(gitPrStatus).toHaveBeenCalledTimes(3);
    await wait(45_000);
    expect(gitPrStatus).toHaveBeenCalledTimes(4);
    await wait(10 * 60_000);
    expect(gitPrStatus).toHaveBeenCalledTimes(4);
  });

  it("a read that says MERGED still makes the panel look the PR up again (4.10)", async () => {
    gitPrStatus.mockResolvedValue(PR);
    invoke.mockImplementation(async (command: string) =>
      command === "git_github_pr_checks" ? { ...CHECKS, state: "MERGED" } : undefined,
    );
    await renderPanel();
    expect(gitPrStatus).toHaveBeenCalledTimes(2);
    expect(header()).toBe("#3 · merged");
  });
});

describe("K7: usePrStatus serves each ask once with lookups off", () => {
  it("a branch change after Check now runs no lookup, and the next ask runs one", async () => {
    gitPrStatus.mockResolvedValue(PR);
    setOutboundCallAllowed("github-lookups", false);
    let seen: PrStatus | undefined;
    function Probe({ branch }: { branch: string }) {
      seen = usePrStatus(CWD, branch);
      return null;
    }
    await act(async () => root.render(createElement(Probe, { branch: "s7r2-pr3" })));
    expect(gitPrStatus).not.toHaveBeenCalled();

    await act(async () => seen!.reload());
    await settle();
    expect(gitPrStatus).toHaveBeenCalledTimes(1);

    await act(async () => root.render(createElement(Probe, { branch: "s7r2-pr4" })));
    await settle();
    await act(async () => root.render(createElement(Probe, { branch: "s7r2-pr3" })));
    await wait(10 * 60_000);
    expect(gitPrStatus).toHaveBeenCalledTimes(1);
    expect(seen).toMatchObject({ pr: PR, cachedOnly: true });

    await act(async () => seen!.reload());
    await settle();
    expect(gitPrStatus).toHaveBeenCalledTimes(2);
  });
});
