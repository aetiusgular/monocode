// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  resetHarnessModelOverlays,
  saveLastModelChoice,
  savePickerProviderVisible,
  saveRecentModelChoice,
} from "../../sessions/model/models";
import { initialQuickChoice, installedQuickChoice } from "./quickComposer";

// 3.19: only Claude Code and Codex are installed. Quick entry opened on
// Cursor ("Composer 2.5"), whose CLI is not found.

beforeEach(() => {
  localStorage.clear();
  resetHarnessModelOverlays();
});
afterEach(() => resetHarnessModelOverlays());

it("never defaults to a provider whose CLI was not found", () => {
  // Nothing saved: the stored default falls back to Cursor.
  expect(initialQuickChoice().harness).toBe("cursor");
  expect(initialQuickChoice(["claude", "codex"]).harness).toBe("claude");
});

it("keeps the last used provider when it is installed", () => {
  saveLastModelChoice("codex", "codex:gpt-5.6-luna");
  expect(initialQuickChoice(["claude", "codex"])).toEqual({
    harness: "codex",
    model: "codex:gpt-5.6-luna",
  });
});

it("falls back to the most recent installed choice, then picker order", () => {
  saveLastModelChoice("cursor", "cursor:composer-2.5");
  saveRecentModelChoice("codex", "codex:gpt-5.6-luna");
  saveRecentModelChoice("cursor", "cursor:composer-2.5");
  expect(initialQuickChoice(["claude", "codex"])).toEqual({
    harness: "codex",
    model: "codex:gpt-5.6-luna",
  });
});

it("skips a provider hidden from the picker", () => {
  savePickerProviderVisible("claude", false);
  expect(
    installedQuickChoice({ harness: "cursor", model: "x" }, ["claude", "codex"])
      .harness,
  ).toBe("codex");
});

it("leaves the choice alone when nothing is installed", () => {
  const choice = { harness: "cursor" as const, model: "cursor:composer-2.5" };
  expect(installedQuickChoice(choice, [])).toBe(choice);
});
