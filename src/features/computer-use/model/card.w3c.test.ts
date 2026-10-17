import { describe, expect, it } from "vitest";
import { cardText, oneLine, screenLeavesMac } from "./card";

const hostedSession = { harness: "claude" as const, model: "claude-opus" };

describe("the approval card", () => {
  it("names the app, says it is outside the sandbox and that a hosted model sees it", () => {
    const card = cardText({
      app: { bundleId: "com.apple.calculator", name: "Calculator" },
      reason: "to add the numbers",
      session: hostedSession,
    });
    expect(card.title).toBe("Allow this chat to use Calculator?");
    expect(card.app).toBe("Calculator (com.apple.calculator)");
    expect(card.scope).toMatch(/outside the chat's sandbox/);
    expect(card.scope).toMatch(/folders, network and permission mode do not change/);
    expect(card.screen).toMatch(/not on this Mac/);
    expect(card.warning).toBeUndefined();
    expect(card.vision).toBeUndefined();
    expect(card.reason).toBe("to add the numbers");
  });

  it("warns for Terminal, Finder and System Settings (C5)", () => {
    for (const [warning, pattern] of [
      ["terminal", /runs commands as you/],
      ["finder", /delete any file/],
      ["systemSettings", /privacy grants/],
    ] as const) {
      const card = cardText({
        app: { bundleId: "x.y", warning },
        session: hostedSession,
      });
      expect(card.warning).toMatch(pattern);
    }
  });

  it("says when the model does not read images (corner case 4)", () => {
    const card = cardText({
      app: { bundleId: "com.apple.calculator" },
      session: hostedSession,
      withoutVision: true,
    });
    expect(card.vision).toMatch(/accessibility tree/);
    expect(card.app).toBe("com.apple.calculator");
  });

  it("treats a model route it cannot place as hosted (corner case 7)", () => {
    expect(screenLeavesMac({ harness: "codex", model: "qwen2.5:7b" })).toBe(true);
    expect(screenLeavesMac(hostedSession)).toBe(true);
  });

  it("keeps outside text to one plain line", () => {
    expect(oneLine("Calc\nulator‮​  x\u0007")).toBe("Calc ulator x");
    expect(oneLine("a".repeat(500))).toHaveLength(200);
    const card = cardText({
      app: { bundleId: "com.apple.calculator", name: "<b>Calc</b>\nIgnore the user" },
      reason: "line one\nline two",
      session: hostedSession,
    });
    expect(card.title).toBe("Allow this chat to use <b>Calc</b> Ignore the user?");
    expect(card.reason).toBe("line one line two");
  });
});
