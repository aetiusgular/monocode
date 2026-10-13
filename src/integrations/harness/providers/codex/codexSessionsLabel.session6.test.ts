import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../features/model-setup/model/modelProviders", () => ({
  findModelProvider: (id: string) =>
    id === "ollama_local" ? { id, label: "Ollama on this Mac", baseUrl: "http://127.0.0.1:11434/v1" } : undefined,
}));

import { codexThreadRows } from "./codexSessions";

// Mac finding 1.14: the pick-up list named the provider by its config id.
describe("pick-up rows name the provider", () => {
  it("by its display name when MonoCode knows it, else by its id", () => {
    const id = "019a0000-0000-7000-8000-000000000001";
    const rows = codexThreadRows(
      [
        { id, cwd: "/p", preview: "hi", modelProvider: "ollama_local", model: "qwen2.5:7b", updatedAt: 1 },
        { id: id.replace(/1$/, "2"), cwd: "/p", preview: "yo", modelProvider: "other_one", model: "m", updatedAt: 2 },
      ],
      "/p",
    );
    const details = rows.map((row) => row.detail);
    expect(details).toContain("recorded with Ollama on this Mac · qwen2.5:7b");
    expect(details).toContain("recorded with other_one · m");
  });
});
