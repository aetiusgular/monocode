// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mac test 4.10, retest 3: a failed gh lookup read as "no PR", so Create PR
// showed for 1 to 3 minutes on a branch with an open PR, and the bar went.

const gitPrStatus = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("../../../platform/tauri/fs", () => ({
  gitDiffIndex: vi.fn(),
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

const PR = {
  number: 1,
  title: "Add a retest line to the README",
  url: "https://github.com/aetiusgular/monocode-pr-test/pull/1",
  state: "open",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  gitPrStatus.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mountProbe() {
  const panel = await import("./GitChangesPanel");
  function Probe() {
    const status = panel.usePrStatus("/Users/t/s7r2-prtest", "s7r2-pr1");
    return createElement("p", null, status.pr ? `pr:${status.pr.number}` : "pr:none");
  }
  await act(async () => root.render(createElement(Probe)));
  await act(async () => {});
}

describe("usePrStatus", () => {
  it("a rejected lookup keeps the PR the last lookup found", async () => {
    gitPrStatus.mockResolvedValue(PR);
    await mountProbe();
    expect(container.textContent).toBe("pr:1");
    gitPrStatus.mockRejectedValue("Could not resolve host: github.com");
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {});
    expect(gitPrStatus).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("pr:1");
  });

  it("a reload shows the cached PR before the lookup answers", async () => {
    gitPrStatus.mockResolvedValue(PR);
    await mountProbe();
    expect(container.textContent).toBe("pr:1");
    act(() => root.unmount());
    // A reload: a fresh module and nothing in memory.
    vi.resetModules();
    gitPrStatus.mockReturnValue(new Promise(() => {}));
    root = createRoot(container);
    await mountProbe();
    expect(container.textContent).toBe("pr:1");
  });
});

describe("with GitHub lookups off (review H1)", () => {
  it("a cached PR shows, marked as not confirmed this run, and gh is not asked", async () => {
    gitPrStatus.mockResolvedValue(PR);
    await mountProbe();
    act(() => root.unmount());
    vi.resetModules();
    gitPrStatus.mockClear();
    const outbound = await import("../../settings/model/outboundCalls");
    outbound.setOutboundCallAllowed("github-lookups", false);
    const panel = await import("./GitChangesPanel");
    let seen: { pr: unknown; answered: boolean; cachedOnly?: boolean } | undefined;
    function Probe() {
      const status = panel.usePrStatus("/Users/t/s7r2-prtest", "s7r2-pr1");
      seen = status;
      return null;
    }
    root = createRoot(container);
    await act(async () => root.render(createElement(Probe)));
    expect(gitPrStatus).not.toHaveBeenCalled();
    expect(seen).toMatchObject({ pr: PR, answered: true, cachedOnly: true });
    outbound.setOutboundCallAllowed("github-lookups", true);
  });
});

describe("J1: a lookup you ask for with GitHub lookups off", () => {
  it("runs once and confirms the PR, and a window focus asks nothing after it", async () => {
    gitPrStatus.mockResolvedValue(PR);
    await mountProbe();
    act(() => root.unmount());
    vi.resetModules();
    gitPrStatus.mockClear();
    const outbound = await import("../../settings/model/outboundCalls");
    outbound.setOutboundCallAllowed("github-lookups", false);
    try {
      const panel = await import("./GitChangesPanel");
      let seen: import("./GitChangesPanel").PrStatus | undefined;
      function Probe() {
        seen = panel.usePrStatus("/Users/t/s7r2-prtest", "s7r2-pr1");
        return null;
      }
      root = createRoot(container);
      await act(async () => root.render(createElement(Probe)));
      expect(gitPrStatus).not.toHaveBeenCalled();
      expect(seen).toMatchObject({ pr: PR, cachedOnly: true });

      // Check now on the bar (or a commit, a push, a new PR) reloads.
      await act(async () => seen!.reload());
      await act(async () => {});
      expect(gitPrStatus).toHaveBeenCalledTimes(1);
      expect(seen).toMatchObject({ pr: PR, answered: true, stale: false });
      // What the bar's `confirmed` reads: a lookup in this run answered.
      expect(seen!.answered && !seen!.cachedOnly).toBe(true);

      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await act(async () => {});
      expect(gitPrStatus).toHaveBeenCalledTimes(1);
    } finally {
      outbound.setOutboundCallAllowed("github-lookups", true);
    }
  });

  it("with lookups on, a window focus still looks the PR up after a reload", async () => {
    gitPrStatus.mockResolvedValue(PR);
    const panel = await import("./GitChangesPanel");
    let seen: import("./GitChangesPanel").PrStatus | undefined;
    function Probe() {
      seen = panel.usePrStatus("/Users/t/s7r2-prtest", "s7r2-pr1");
      return null;
    }
    await act(async () => root.render(createElement(Probe)));
    await act(async () => {});
    await act(async () => seen!.reload());
    await act(async () => {});
    const calls = gitPrStatus.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {});
    expect(gitPrStatus).toHaveBeenCalledTimes(calls + 1);
  });
});

describe("Create PR", () => {
  it("shows only after a lookup answered and found none", async () => {
    const { GitSyncActions } = await import("./GitChangesPanel");
    const props = {
      index: {
        branch: "s7r2-pr1",
        defaultBranch: "main",
        remote: "origin",
        upstream: "origin/s7r2-pr1",
        ahead: 0,
        behind: 0,
        aheadOfDefault: 1,
        files: [],
      } as never,
      pr: null,
      busy: null,
      hasRemote: true,
      hasOpenPr: false,
      onDefault: false,
      canSync: false,
      canPublish: false,
      canCreatePr: true,
      canViewPr: false,
      onSync: () => {},
      onCreatePr: () => {},
      onViewPr: () => {},
    };
    expect(renderToStaticMarkup(createElement(GitSyncActions, { ...props, prKnown: false }))).not.toContain(
      "Create PR",
    );
    expect(renderToStaticMarkup(createElement(GitSyncActions, { ...props, prKnown: true }))).toContain(
      "Create PR",
    );
  });
});
