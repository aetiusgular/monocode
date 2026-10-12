import { describe, expect, it } from "vitest";
import { buildThreadStartParams, buildTurnStartParams } from "./codexProtocol";

describe("F2 in Codex's thread start", () => {
  it("sends developer instructions on thread/start", () => {
    const params = buildThreadStartParams({
      cwd: "/code/app",
      runtimeMode: "supervised",
      developerInstructions: "Answer briefly.",
    });
    expect(params.developerInstructions).toBe("Answer briefly.");
  });

  it("leaves the field out when there is nothing to say", () => {
    for (const developerInstructions of [undefined, "", "   "]) {
      const params = buildThreadStartParams({
        cwd: "/code/app",
        runtimeMode: "supervised",
        developerInstructions,
      });
      expect("developerInstructions" in params).toBe(false);
    }
  });

  it("does not touch the turn's collaboration mode", () => {
    const params = buildTurnStartParams({
      threadId: "t",
      runtimeMode: "supervised",
      model: "qwen2.5:7b",
      prompt: "hi",
    });
    expect(
      (params.collaborationMode as { settings: Record<string, unknown> })
        .settings.developer_instructions,
    ).toBeNull();
  });
});
