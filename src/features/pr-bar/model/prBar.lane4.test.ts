import { beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  autoFixWarning,
  decideAutoFix,
  DEFAULT_PR_BAR,
  MAX_FIX_ATTEMPTS,
  PR_BAR_KEY,
  prBarSettings,
  prKey,
  prRefFromUrl,
  resetPrBarCache,
  sanitizePrBarStore,
  savePrBarSettings,
  shouldAutoArchive,
  type PrBarSettings,
} from "./prBar";
import { PrBar } from "../ui/PrBar";
import type { GithubPrChecks } from "../../inbox/model/githubPrChecks";
import { resetHarnessModelOverlays, setHarnessModels } from "../../sessions/model/models";
import { resetTraitOverridesCache } from "../../model-traits/model/modelTraits";

function mockLocalStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      clear: () => data.clear(),
      key: () => null,
      length: 0,
    },
    configurable: true,
  });
}

beforeEach(() => {
  mockLocalStorage();
  resetPrBarCache();
  resetTraitOverridesCache();
  resetHarnessModelOverlays();
});

const check = (state: "pass" | "fail" | "pending", name = state) => ({
  name,
  workflow: "ci",
  state,
  url: null,
  startedAt: null,
  completedAt: null,
});
const checks = (head: string, ...states: ("pass" | "fail" | "pending")[]): GithubPrChecks => ({
  headOid: head,
  checks: states.map((state, index) => check(state, `${state}${index}`)),
});
const on: PrBarSettings = { ...DEFAULT_PR_BAR, autoFix: true };

describe("prRefFromUrl", () => {
  it("reads github.com pull request URLs only", () => {
    expect(prRefFromUrl("https://github.com/aetiusgular/monocode/pull/12")).toEqual({
      repo: "aetiusgular/monocode",
      number: 12,
    });
    for (const bad of [
      "https://gitlab.com/a/b/pull/1",
      "http://github.com/a/b/pull/1",
      "https://github.com.evil.example/a/b/pull/1",
      "https://github.com/a/b/issues/1",
      "https://github.com/a/b/pull/0",
      "https://github.com/a/b/pull/1/../../x",
      "not a url",
      null,
    ]) {
      expect(prRefFromUrl(bad)).toBeNull();
    }
  });
});

describe("auto-fix (off by default, 2 tries)", () => {
  it("is off by default", () => {
    expect(decideAutoFix({ settings: DEFAULT_PR_BAR, checks: checks("abc1234", "fail"), hasChat: true })).toEqual({
      send: false,
      reason: "off",
    });
  });

  it("sends when a check failed and none is running", () => {
    const decision = decideAutoFix({ settings: on, checks: checks("abc1234", "pass", "fail"), hasChat: true });
    expect(decision.send).toBe(true);
    if (decision.send) expect(decision.failed.map((c) => c.name)).toEqual(["fail1"]);
  });

  it("waits while checks run, and needs a chat", () => {
    expect(decideAutoFix({ settings: on, checks: checks("abc1234", "fail", "pending"), hasChat: true })).toMatchObject({ reason: "still-running" });
    expect(decideAutoFix({ settings: on, checks: checks("abc1234", "fail"), hasChat: false })).toMatchObject({ reason: "no-chat" });
    expect(decideAutoFix({ settings: on, checks: checks("abc1234", "pass"), hasChat: true })).toMatchObject({ reason: "no-failure" });
    expect(decideAutoFix({ settings: on, checks: null, hasChat: true })).toMatchObject({ reason: "no-failure" });
  });

  it("never sends twice for one commit, and stops after 2", () => {
    expect(
      decideAutoFix({ settings: { ...on, fixAttempts: 1, lastFixedHead: "abc1234" }, checks: checks("abc1234", "fail"), hasChat: true }),
    ).toMatchObject({ reason: "same-commit" });
    expect(
      decideAutoFix({ settings: { ...on, fixAttempts: 1, lastFixedHead: "abc1234" }, checks: checks("def5678", "fail"), hasChat: true }).send,
    ).toBe(true);
    expect(
      decideAutoFix({ settings: { ...on, fixAttempts: MAX_FIX_ATTEMPTS }, checks: checks("def5678", "fail"), hasChat: true }),
    ).toMatchObject({ reason: "limit" });
  });

  it("warns unless the model is marked a reliable tool caller (case 2)", () => {
    setHarnessModels("codex", [{ id: "codex:qwen2.5:7b", harness: "codex", name: "q", nativeId: "qwen2.5:7b" }]);
    expect(autoFixWarning("codex:qwen2.5:7b")).toMatch(/not marked as a reliable tool caller/);
    expect(autoFixWarning(undefined)).toBeDefined();
    setHarnessModels("codex", [{ id: "codex:big", harness: "codex", name: "b", nativeId: "big", tools: "reliable" }]);
    expect(autoFixWarning("codex:big")).toBeUndefined();
  });
});

describe("auto-archive", () => {
  it("archives once, when merged or closed, with the switch on", () => {
    const settings = { ...DEFAULT_PR_BAR, autoArchive: true };
    expect(shouldAutoArchive({ settings, state: "MERGED", hasChat: true })).toBe(true);
    expect(shouldAutoArchive({ settings, state: "closed", hasChat: true })).toBe(true);
    expect(shouldAutoArchive({ settings, state: "open", hasChat: true })).toBe(false);
    expect(shouldAutoArchive({ settings: { ...settings, archived: true }, state: "merged", hasChat: true })).toBe(false);
    expect(shouldAutoArchive({ settings: DEFAULT_PR_BAR, state: "merged", hasChat: true })).toBe(false);
    expect(shouldAutoArchive({ settings, state: "merged", hasChat: false })).toBe(false);
  });
});

describe("storage", () => {
  const ref = { repo: "Acme/Web", number: 7 };

  it("keeps switches per PR across a reload (case 14)", () => {
    savePrBarSettings(ref, { autoFix: true, autoMerge: "squash" });
    resetPrBarCache();
    expect(prBarSettings({ repo: "acme/web", number: 7 })).toMatchObject({ autoFix: true, autoMerge: "squash", fixAttempts: 0 });
    expect(prKey(ref)).toBe("acme/web#7");
  });

  it("sanitizes what it reads", () => {
    localStorage.setItem(
      PR_BAR_KEY,
      JSON.stringify({
        "acme/web#1": { autoFix: "yes", autoMerge: "force", fixAttempts: 99, lastFixedHead: "$(rm)" },
        "bad key": { autoFix: true },
      }),
    );
    resetPrBarCache();
    expect(prBarSettings({ repo: "acme/web", number: 1 })).toEqual({
      autoArchive: false,
      autoFix: false,
      fixAttempts: MAX_FIX_ATTEMPTS,
    });
    expect(Object.keys(sanitizePrBarStore({ "bad key": {} }))).toEqual([]);
  });
});

describe("PrBar", () => {
  it("renders the three switches for an open PR, auto-fix off", () => {
    const html = renderToStaticMarkup(
      createElement(PrBar, {
        cwd: "/repo",
        pr: { number: 7, url: "https://github.com/acme/web/pull/7", state: "open" },
        owner: { kind: "route", harness: "codex", sessionId: "s1", modelId: "codex:qwen2.5:7b" },
      }),
    );
    expect(html).toContain("Auto-merge");
    expect(html).toContain("Auto-fix failed checks");
    expect(html).toContain("Archive the chat when merged or closed");
    expect(html).toContain('aria-label="Auto-fix failed checks" aria-checked="false"');
  });

  it("says why auto-fix is off with no chat for the checkout", () => {
    const html = renderToStaticMarkup(
      createElement(PrBar, {
        cwd: "/repo",
        pr: { number: 7, url: "https://github.com/acme/web/pull/7", state: "open" },
      }),
    );
    expect(html).toContain("No open chat works in this checkout");
  });

  it("renders nothing for a non-GitHub PR", () => {
    expect(
      renderToStaticMarkup(
        createElement(PrBar, { cwd: "/repo", pr: { number: 1, url: "https://gitlab.com/a/b/pull/1", state: "open" } }),
      ),
    ).toBe("");
  });
});
