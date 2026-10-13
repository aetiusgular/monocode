// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { commit, pr, ask } = vi.hoisted(() => ({
  commit: vi.fn(async () => "Commit from the helper"),
  pr: vi.fn(async () => ({ title: "t", body: "b", base: "main", head: "x" })),
  ask: vi.fn(async (_message: string, _options?: unknown) => false),
}));
// A native dialog, not window.confirm, which the macOS webview was never
// seen to show (Mac finding 10.2).
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask }));
vi.mock("./availability", () => ({ isHarnessAvailable: () => true }));
vi.mock("./registry", () => ({
  generateHarnessCommitMessage: commit,
  generateHarnessPrContent: pr,
  warmupHarnessText: vi.fn(async () => {}),
}));

import {
  UNOWNED_REFUSED,
  generateCommitMessage,
  generatePrContent,
} from "./textHarness";
import { reviewConsented } from "../../../features/code-review/model/reviewConsent";

beforeEach(() => {
  localStorage.clear();
  commit.mockClear();
  pr.mockClear();
  ask.mockReset();
  ask.mockResolvedValue(false);
});
afterEach(() => vi.restoreAllMocks());

it("asks before a checkout no chat owns sends its diff to a harness (F3, case 7)", async () => {
  const confirm = ask;
  await expect(generateCommitMessage("/repo", "claude")).rejects.toThrow(
    UNOWNED_REFUSED,
  );
  expect(commit).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm.mock.calls[0][0]).toMatch(/leave this computer/);
  expect(reviewConsented("helper:claude:/repo")).toBe(false);
});

it("falls back to no PR text when the user says no", async () => {
  await expect(generatePrContent("/repo", "codex")).resolves.toBeNull();
  expect(pr).not.toHaveBeenCalled();
});

it("asks once per project and harness, apart from code review", async () => {
  const confirm = ask;
  ask.mockResolvedValue(true);
  await expect(generateCommitMessage("/repo", "claude")).resolves.toBe(
    "Commit from the helper",
  );
  await generatePrContent("/repo", "claude");
  expect(confirm).toHaveBeenCalledTimes(1);
  // Code review's own consent for the project is not given by this yes.
  expect(reviewConsented("/repo")).toBe(false);
  // Another harness, or another project, asks again.
  await generateCommitMessage("/repo", "codex");
  await generateCommitMessage("/other", "claude");
  expect(confirm).toHaveBeenCalledTimes(3);
});

it("does not ask when a chat owns the checkout (its own route)", async () => {
  const confirm = ask;
  const route = {
    kind: "route" as const,
    harness: "codex" as const,
    modelId: "qwen2.5:7b",
  };
  // The route path goes to the helper prompt, not the bare-id fallback.
  await generateCommitMessage("/repo", route).catch(() => undefined);
  expect(confirm).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
});

it("a dialog that fails to open counts as no", async () => {
  ask.mockRejectedValue(new Error("no dialog here"));
  await expect(generateCommitMessage("/repo", "claude")).rejects.toThrow(
    UNOWNED_REFUSED,
  );
  expect(commit).not.toHaveBeenCalled();
  expect(reviewConsented("helper:claude:/repo")).toBe(false);
});

it("names the harness by its title and never calls window.confirm", async () => {
  const confirm = vi.spyOn(window, "confirm");
  await generateCommitMessage("/repo", "claude").catch(() => undefined);
  expect(String(ask.mock.calls[0][0])).toMatch(/Claude Code, which is hosted or not known to be local/);
  expect(confirm).not.toHaveBeenCalled();
});
