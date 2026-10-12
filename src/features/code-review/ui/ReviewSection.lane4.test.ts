import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../model-setup/model/providerLocality", () => ({
  providerLocality: (id: string | undefined) => (id === "ollama_local" ? "local" : "unknown"),
}));

import { ReviewSection, reviewerChoices } from "./ReviewSection";

const owner = {
  kind: "route" as const,
  harness: "codex" as const,
  providerAccountId: "local",
  modelId: "codex:qwen2.5:7b",
  modelProvider: "ollama_local",
};

describe("reviewer choices", () => {
  it("puts the session's own route first and marks local or hosted", () => {
    const choices = reviewerChoices(owner, (harness) => harness === "claude");
    expect(choices.map((choice) => [choice.id, choice.locality])).toEqual([
      ["owner", "local"],
      ["claude", "hosted"],
    ]);
    expect(choices[0].label).toBe("This session (Codex)");
  });

  it("offers only installed harnesses with a side prompt (case 11)", () => {
    expect(reviewerChoices(undefined, () => false)).toEqual([]);
  });
});

describe("ReviewSection", () => {
  it("starts closed with one button, disabled with nothing to review", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewSection, { cwd: "/repo", owner, hasChanges: false }),
    );
    expect(html).toContain("Review changes");
    expect(html).toContain("disabled");
  });
});
