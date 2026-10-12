// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { commit, pr } = vi.hoisted(() => ({
  commit: vi.fn(async () => "Commit from the helper"),
  pr: vi.fn(async () => ({ title: "t", body: "b", base: "main", head: "x" })),
}));
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
});
afterEach(() => vi.restoreAllMocks());

it("asks before a checkout no chat owns sends its diff to a harness (F3, case 7)", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await expect(generateCommitMessage("/repo", "claude")).rejects.toThrow(
    UNOWNED_REFUSED,
  );
  expect(commit).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm.mock.calls[0][0]).toMatch(/leave this computer/);
  expect(reviewConsented("/repo")).toBe(false);
});

it("falls back to no PR text when the user says no", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(false);
  await expect(generatePrContent("/repo", "codex")).resolves.toBeNull();
  expect(pr).not.toHaveBeenCalled();
});

it("asks once per project, and the answer is shared with code review", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  await expect(generateCommitMessage("/repo", "claude")).resolves.toBe(
    "Commit from the helper",
  );
  await generatePrContent("/repo", "claude");
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(reviewConsented("/repo")).toBe(true);
  // Another project asks again.
  await generateCommitMessage("/other", "codex");
  expect(confirm).toHaveBeenCalledTimes(2);
});

it("does not ask when a chat owns the checkout (its own route)", async () => {
  const confirm = vi.spyOn(window, "confirm");
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
