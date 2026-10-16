// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => false }));

import {
  AUTO_MERGE_NOT_ALLOWED_TEXT,
  autoMergeRefusalText,
  autoMergeView,
  DRAFT_TEXT,
  MERGE_NOW_TEXT,
  PR_BAR_KEY,
  prBarSettings,
  resetPrBarCache,
  savePrBarSettings,
  UNSTABLE_TEXT,
} from "./prBar";
import { PrBar } from "../ui/PrBar";
import type { GithubPrChecks } from "../../inbox/model/githubPrChecks";

// Mac test 4.10, retest 3 (15 Oct, 5733804). Auto-merge on PR #1, whose
// checks had passed, merged it at once: gh 2.94.0's `pr merge --auto` merges
// immediately when mergeStateStatus is CLEAN, HAS_HOOKS or UNSTABLE.

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const PR = {
  number: 1,
  url: "https://github.com/aetiusgular/monocode-pr-test/pull/1",
  state: "open",
};

function checks(patch: Partial<GithubPrChecks> = {}): GithubPrChecks {
  return {
    headOid: HEAD,
    checks: [],
    prId: "PR_kwDOQ7aZ3s6abcde",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    autoMergeRequest: null,
    ...patch,
  };
}

const ON_TEXT =
  "Auto-merge is on (squash). GitHub merges this PR when its required checks and reviews pass.";

beforeEach(() => {
  localStorage.clear();
  resetPrBarCache();
  invoke.mockReset();
});

describe("which PRs get the auto-merge switch", () => {
  it.each(["CLEAN", "HAS_HOOKS"])("%s: no switch, nothing to wait for", (status) => {
    expect(autoMergeView(checks({ mergeStateStatus: status }))).toEqual({
      kind: "merge-now",
      text: "Nothing to wait for: GitHub would merge this PR now. Merge it on GitHub.",
    });
  });

  it("UNSTABLE: no switch, and says a check that is not required is failing", () => {
    expect(autoMergeView(checks({ mergeStateStatus: "UNSTABLE" }))).toEqual({
      kind: "merge-now",
      text: `${MERGE_NOW_TEXT} ${UNSTABLE_TEXT}`,
    });
    expect(UNSTABLE_TEXT).toBe("A check that is not required is failing.");
  });

  it.each(["BLOCKED", "BEHIND", "DIRTY", "UNKNOWN"])("%s: the switch is offered", (status) => {
    expect(autoMergeView(checks({ mergeStateStatus: status }))).toEqual({ kind: "available" });
  });

  it("a draft: Drafts can't auto-merge", () => {
    expect(autoMergeView(checks({ isDraft: true }))).toEqual({ kind: "draft", text: DRAFT_TEXT });
    expect(autoMergeView(checks({ mergeStateStatus: "DRAFT" }))).toEqual({ kind: "draft", text: DRAFT_TEXT });
    expect(DRAFT_TEXT).toBe("Drafts can't auto-merge.");
  });

  it("an existing request shows as on, whatever the merge state, so it can go off", () => {
    for (const status of ["BLOCKED", "CLEAN", "UNSTABLE"]) {
      expect(
        autoMergeView(checks({ mergeStateStatus: status, autoMergeRequest: { mergeMethod: "SQUASH" } })),
      ).toEqual({ kind: "on", method: "squash", text: ON_TEXT });
    }
  });

  it("nothing is offered before GitHub has been read", () => {
    expect(autoMergeView(null)).toEqual({ kind: "unknown" });
    expect(autoMergeView(checks({ prId: null }))).toEqual({ kind: "unknown" });
  });
});

describe("GitHub's refusals", () => {
  it("names where to switch auto-merge on for the repository", () => {
    expect(autoMergeRefusalText("Pull request Auto merge is not allowed for this repository")).toBe(
      "Auto-merge is off for this repository on GitHub (Settings, General, Allow auto-merge).",
    );
    expect(AUTO_MERGE_NOT_ALLOWED_TEXT).toContain("Allow auto-merge");
  });

  it("shows any other refusal in GitHub's own words", () => {
    expect(autoMergeRefusalText("Pull request Pull request is in clean status")).toBe(
      "Pull request Pull request is in clean status",
    );
  });
});

describe("storage keeps only the preferred method", () => {
  it("an old stored switch reads as a preferred method, never as on", () => {
    localStorage.setItem(PR_BAR_KEY, JSON.stringify({ "acme/web#7": { autoMerge: "rebase", autoFix: true } }));
    resetPrBarCache();
    const settings = prBarSettings({ repo: "acme/web", number: 7 });
    expect(settings.mergeMethod).toBe("rebase");
    expect(settings).not.toHaveProperty("autoMerge");
  });
});

describe("the bar follows GitHub, not local storage", () => {
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(PrBar, { cwd: "/repo", pr: PR, ...props }));

  it("CLEAN: no switch, the text instead", () => {
    const html = render({ initialChecks: checks({ mergeStateStatus: "CLEAN" }) });
    expect(html).not.toContain('aria-label="Auto-merge"');
    expect(html).toContain(MERGE_NOW_TEXT);
  });

  it("UNSTABLE: no switch, both lines", () => {
    const html = render({ initialChecks: checks({ mergeStateStatus: "UNSTABLE" }) });
    expect(html).not.toContain('aria-label="Auto-merge"');
    expect(html).toContain(UNSTABLE_TEXT);
  });

  it("a request on GitHub reads on, with nothing stored", () => {
    const html = render({ initialChecks: checks({ autoMergeRequest: { mergeMethod: "SQUASH" } }) });
    expect(html).toContain('aria-label="Auto-merge" aria-checked="true"');
    expect(html).toContain(ON_TEXT);
  });

  it("no request on GitHub reads off, whatever was stored", () => {
    savePrBarSettings({ repo: "aetiusgular/monocode-pr-test", number: 1 }, { mergeMethod: "merge" });
    localStorage.setItem(
      PR_BAR_KEY,
      JSON.stringify({ "aetiusgular/monocode-pr-test#1": { autoMerge: "squash" } }),
    );
    resetPrBarCache();
    const html = render({ initialChecks: checks() });
    expect(html).toContain('aria-label="Auto-merge" aria-checked="false"');
    expect(html).not.toContain(ON_TEXT);
  });

  it("while the lookup is stale every switch is off and it says when it last checked", () => {
    const html = render({
      initialChecks: checks(),
      stale: true,
      checkedAt: Date.UTC(2026, 9, 15, 17, 42),
      owner: { kind: "route", harness: "codex", sessionId: "s1", modelId: "codex:qwen2.5:7b" },
    });
    for (const label of ["Auto-merge", "Auto-fix failed checks", "Archive the chat when merged or closed"]) {
      expect(html).toMatch(new RegExp(`aria-label="${label}" aria-checked="[a-z]+" disabled=""`));
    }
    expect(html).toContain("last checked");
  });
});

describe("turning auto-merge on and off", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mount(first: GithubPrChecks) {
    invoke.mockImplementation(async (command: string) => {
      if (command === "git_github_pr_checks") return first;
      throw new Error(`unexpected ${command}`);
    });
    await act(async () => {
      root.render(createElement(PrBar, { cwd: "/repo", pr: PR }));
    });
    await act(async () => {});
  }
  const toggle = () => container.querySelector<HTMLButtonElement>('[aria-label="Auto-merge"]')!;

  it("on: GitHub's mutation with the head the bar showed, then what GitHub says", async () => {
    await mount(checks());
    invoke.mockImplementation(async (command: string) => {
      if (command === "git_github_pr_auto_merge") {
        return { pr: checks({ autoMergeRequest: { mergeMethod: "SQUASH" } }) };
      }
      return checks({ autoMergeRequest: { mergeMethod: "SQUASH" } });
    });
    await act(async () => toggle().click());
    expect(invoke).toHaveBeenCalledWith("git_github_pr_auto_merge", {
      cwd: "/repo",
      repo: "aetiusgular/monocode-pr-test",
      number: 1,
      enable: true,
      prId: "PR_kwDOQ7aZ3s6abcde",
      method: "squash",
      expectedHeadOid: HEAD,
    });
    expect(invoke.mock.calls.some(([command]) => command === "git_github_pr_action")).toBe(false);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain(ON_TEXT);
  });

  it("a refusal shows GitHub's reason and the switch stays as GitHub reads", async () => {
    await mount(checks());
    invoke.mockImplementation(async (command: string) =>
      command === "git_github_pr_auto_merge"
        ? { refusal: "Pull request Auto merge is not allowed for this repository", pr: checks() }
        : checks(),
    );
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain(AUTO_MERGE_NOT_ALLOWED_TEXT);
  });

  it("a failed call that still turned it on reads as on", async () => {
    await mount(checks());
    const on = checks({ autoMergeRequest: { mergeMethod: "SQUASH" } });
    invoke.mockImplementation(async (command: string) =>
      command === "git_github_pr_auto_merge" ? { refusal: "unexpected EOF", pr: on } : on,
    );
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("unexpected EOF");
  });

  it("off: only while GitHub reports a request", async () => {
    await mount(checks({ autoMergeRequest: { mergeMethod: "MERGE" } }));
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    invoke.mockImplementation(async (command: string) =>
      command === "git_github_pr_auto_merge" ? { pr: checks() } : checks(),
    );
    await act(async () => toggle().click());
    expect(invoke).toHaveBeenCalledWith(
      "git_github_pr_auto_merge",
      expect.objectContaining({ enable: false, prId: "PR_kwDOQ7aZ3s6abcde", method: null, expectedHeadOid: null }),
    );
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });
});
