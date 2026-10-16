import { describe, expect, it } from "vitest";
import { recordActivity, recordApproval } from "./activityStore";

// The contract callers rely on: recording never throws, so a log that cannot
// be written never stops a turn (rules, section 4, case 9).
describe("activity store contract", () => {
  it("accepts an event and returns nothing", () => {
    expect(
      recordActivity({
        id: "e1",
        at: 0,
        chatId: "",
        harness: "",
        source: "adapter",
        kind: "tool.call",
        summary: "",
        detail: {},
      }),
    ).toBeUndefined();
  });

  it("accepts an approval record and returns nothing", () => {
    expect(
      recordApproval({
        id: "a1",
        chatId: "c1",
        harness: "codex",
        subject: "command",
        target: "npm test",
        scope: "chat",
        granted: true,
        grantedAt: 1,
      }),
    ).toBeUndefined();
  });
});
