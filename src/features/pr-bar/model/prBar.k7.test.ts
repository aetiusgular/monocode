// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => false }));

import { CHECK_POLL_MS, PrBar } from "../ui/PrBar";
import { resetPrBarCache } from "./prBar";
import {
  resetOutboundCallsCache,
  setOutboundCallAllowed,
} from "../../settings/model/outboundCalls";
import type { GithubPrChecks } from "../../inbox/model/githubPrChecks";

// K7 of the security review: with "GitHub lookups" off the bar runs nothing
// on its own after Check now. No lookup after a MERGED or CLOSED read, no
// read for a new PR address, and a failed lookup says so with Check now.

const PR = {
  number: 3,
  url: "https://github.com/aetiusgular/monocode-pr-test/pull/3",
  state: "open",
};
const PR4 = {
  number: 4,
  url: "https://github.com/aetiusgular/monocode-pr-test/pull/4",
  state: "open",
};

function checks(patch: Partial<GithubPrChecks> = {}): GithubPrChecks {
  return {
    headOid: "0123456789abcdef0123456789abcdef01234567",
    checks: [
      { name: "build", workflow: "ci", state: "pass", url: null, startedAt: null, completedAt: null },
    ],
    number: 3,
    prId: "PR_kwDOQ7aZ3s6abcde",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    autoMergeRequest: null,
    ...patch,
  };
}

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
const checkNow = () =>
  [...container.querySelectorAll("button")].find((button) => button.textContent === "Check now");
const checksReads = () => invoke.mock.calls.filter(([command]) => command === "git_github_pr_checks");

describe("K7: lookups off", () => {
  it.each(["MERGED", "CLOSED"])(
    "a %s read after Check now shows it, and runs no lookup beyond the one Check now asked for",
    async (state) => {
      setOutboundCallAllowed("github-lookups", false);
      const reloadPr = vi.fn();
      invoke.mockResolvedValue(checks({ state }));
      await render({ checkedAt: 9_000, reloadPr });
      expect(invoke).not.toHaveBeenCalled();

      await act(async () => checkNow()!.click());
      await settle();
      expect(header()).toBe(`#3 · ${state.toLowerCase()}`);
      expect(checksReads()).toHaveLength(1);
      expect(reloadPr).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * CHECK_POLL_MS);
      });
      expect(checksReads()).toHaveLength(1);
      expect(reloadPr).toHaveBeenCalledTimes(1);
    },
  );

  it("a new PR address after Check now is not read on its own; the next Check now reads it once", async () => {
    setOutboundCallAllowed("github-lookups", false);
    const reloadPr = vi.fn();
    invoke.mockResolvedValue(checks());
    await render({ reloadPr });
    await act(async () => checkNow()!.click());
    await settle();
    expect(checksReads()).toHaveLength(1);

    // The same bar, now for #4, as when a caller gives no key.
    invoke.mockResolvedValue(checks({ number: 4 }));
    await act(async () => root.render(createElement(PrBar, { cwd: "/repo", pr: PR4, reloadPr })));
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * CHECK_POLL_MS);
    });
    expect(checksReads()).toHaveLength(1);
    expect(container.querySelector("[data-pr-bar] [class*='animate-spin']")).toBeNull();

    await act(async () => checkNow()!.click());
    await settle();
    expect(checksReads()).toHaveLength(2);
    expect(checksReads()[1][1]).toEqual({ cwd: "/repo", repo: "aetiusgular/monocode-pr-test", number: 4 });
    expect(reloadPr).toHaveBeenCalledTimes(2);
  });

  it("turning lookups off reads nothing more", async () => {
    invoke.mockResolvedValue(checks());
    await render({ checkedAt: 9_000 });
    expect(checksReads()).toHaveLength(1);
    await act(async () => setOutboundCallAllowed("github-lookups", false));
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * CHECK_POLL_MS);
    });
    expect(checksReads()).toHaveLength(1);
  });

  it("a failed lookup says so in the stale style, and Check now is offered again", async () => {
    setOutboundCallAllowed("github-lookups", false);
    await render({ stale: true, confirmed: false, checkedAt: Date.UTC(2026, 9, 16, 17, 42) });
    const note = container.querySelector("[data-pr-lookup-stale]");
    expect(note?.className).toContain("text-amber-400");
    expect(note?.textContent).toMatch(/^ · lookup failed, last checked \d{1,2}:42/);
    expect(checkNow()).toBeDefined();
    // Never checked before: it says that too.
    await render({ stale: true, confirmed: false, checkedAt: null });
    expect(container.querySelector("[data-pr-lookup-stale]")?.textContent).toBe(
      " · lookup failed, not checked yet",
    );
  });
});

describe("K7: lookups on, as before", () => {
  it("a MERGED read makes the bar look the PR up again (4.10)", async () => {
    const reloadPr = vi.fn();
    invoke.mockResolvedValue(checks({ state: "MERGED" }));
    await render({ checkedAt: 9_000, reloadPr });
    expect(header()).toBe("#3 · merged");
    expect(reloadPr).toHaveBeenCalledTimes(1);
  });

  it("turning lookups on after a MERGED read with them off runs the reload then", async () => {
    setOutboundCallAllowed("github-lookups", false);
    const reloadPr = vi.fn();
    invoke.mockResolvedValue(checks({ state: "MERGED" }));
    await render({ checkedAt: 9_000, reloadPr });
    await act(async () => checkNow()!.click());
    await settle();
    expect(reloadPr).toHaveBeenCalledTimes(1);
    await act(async () => setOutboundCallAllowed("github-lookups", true));
    await settle();
    expect(reloadPr).toHaveBeenCalledTimes(2);
  });

  it("a new PR address is read at once", async () => {
    invoke.mockResolvedValue(checks());
    await render({ checkedAt: 9_000 });
    expect(checksReads()).toHaveLength(1);
    invoke.mockResolvedValue(checks({ number: 4 }));
    await act(async () => root.render(createElement(PrBar, { cwd: "/repo", pr: PR4, checkedAt: 9_000 })));
    await settle();
    expect(checksReads()).toHaveLength(2);
  });

  it("a stale lookup says when it last checked, not that it failed, and has no Check now", async () => {
    invoke.mockResolvedValue(checks());
    await render({ stale: true, checkedAt: Date.UTC(2026, 9, 16, 17, 42) });
    const note = container.querySelector("[data-pr-lookup-stale]");
    expect(note?.textContent).toMatch(/^ · last checked \d{1,2}:42/);
    expect(note?.textContent).not.toContain("failed");
    expect(checkNow()).toBeUndefined();
  });
});
