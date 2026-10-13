import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import { workSummaryLine } from "./transcriptActivity";

// Mac 5.13: a turn header said "Edited 2 files" though one of the two writes
// was declined.

const edit = (
  id: string,
  path: string,
  extra: Partial<Block> = {},
  status = "completed",
): Block => ({
  id,
  role: "tool",
  text: `Edit ${path}`,
  tool: {
    kind: "edit",
    status,
    title: `Edit ${path}`,
    preview: { kind: "write", path, fileName: path.split("/").pop() },
  },
  ...extra,
});

describe("the edit clause of a turn header", () => {
  it("leaves out a write declined on its card", () => {
    const steps = [
      edit("a", "/Users/tony/my proj/notes.md"),
      edit("b", "/Users/tony/my proj/-draft.md", {
        approval: { requestId: 1, decided: "deny" },
      }),
    ];
    expect(workSummaryLine(steps)).toBe("Edited notes.md");
  });

  it("leaves out a write refused by a rule or that failed", () => {
    const steps = [
      edit("a", "/repo/a.ts"),
      edit("b", "/repo/b.ts", {}, "cancelled"),
      edit("c", "/repo/c.ts", {}, "failed"),
      edit("d", "/repo/d.ts"),
    ];
    expect(workSummaryLine(steps)).toBe("Edited 2 files");
  });

  it("says no edit went through when none did", () => {
    expect(
      workSummaryLine([
        edit("b", "/repo/b.ts", {
          approval: { requestId: 1, decided: "deny" },
        }),
      ]),
    ).toBe("Edit not applied");
    expect(
      workSummaryLine([
        edit("b", "/repo/b.ts", {}, "failed"),
        edit("c", "/repo/c.ts", {}, "cancelled"),
      ]),
    ).toBe("2 edits not applied");
  });

  it("still counts an edit in flight", () => {
    expect(
      workSummaryLine([edit("a", "/repo/a.ts", {}, "in_progress")], true),
    ).toBe("Editing a.ts");
  });
});
