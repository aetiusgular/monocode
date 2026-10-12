import { describe, expect, it } from "vitest";
import { newSession } from "../../sessions/model/session";
import {
  boundProviderSessions,
  cleanImportedText,
  importedBlocks,
  isProviderSessionId,
  limitImportedHistory,
  MAX_IMPORTED_TEXT,
  MAX_IMPORTED_TOTAL,
  MAX_IMPORTED_TURNS,
  MAX_SESSION_ROWS,
  pickedUpSession,
  pickUpNotice,
  rowAge,
  sanitizeSessionRows,
} from "./sessionImport";

describe("isProviderSessionId", () => {
  it("takes harness ids and refuses paths, flags and shell words", () => {
    expect(isProviderSessionId("01a12f38-b4d1-7a53-b18c-c890daa747d4")).toBe(true);
    expect(isProviderSessionId("abc_123")).toBe(true);
    for (const bad of ["", "-c", "../x", "a b", "a/b", "$(rm)", "x".repeat(129), 7, null]) {
      expect(isProviderSessionId(bad)).toBe(false);
    }
  });
});

describe("cleanImportedText", () => {
  it("removes control characters but keeps line breaks and tabs", () => {
    expect(cleanImportedText("a\u001b[31mb\u0007\nc\td\u0000", 100)).toBe("a[31mb\nc\td");
  });

  it("caps long text with an ellipsis", () => {
    expect(cleanImportedText("abcdef", 4)).toBe("abc…");
    expect(cleanImportedText(42, 4)).toBe("");
  });
});

describe("sanitizeSessionRows", () => {
  it("keeps valid rows, newest first, one line each", () => {
    const rows = sanitizeSessionRows([
      { id: "old", title: "first\nline", updatedAt: 1 },
      { id: "new", title: "  ", updatedAt: 5, detail: "recorded with mock" },
      { id: "../etc", title: "bad", updatedAt: 9 },
      { id: "nan", title: "x", updatedAt: Number.NaN },
      "junk",
      null,
    ]);
    expect(rows).toEqual([
      { id: "new", title: "Untitled session", updatedAt: 5, detail: "recorded with mock" },
      { id: "old", title: "first line", updatedAt: 1 },
      { id: "nan", title: "x", updatedAt: 0 },
    ]);
  });

  it("keeps the newest of duplicate ids and caps the list", () => {
    expect(
      sanitizeSessionRows([
        { id: "a", title: "old", updatedAt: 1 },
        { id: "a", title: "new", updatedAt: 2 },
      ]),
    ).toEqual([{ id: "a", title: "new", updatedAt: 2 }]);
    const many = Array.from({ length: MAX_SESSION_ROWS + 20 }, (_, i) => ({
      id: `s${i}`,
      title: "t",
      updatedAt: i,
    }));
    const rows = sanitizeSessionRows(many);
    expect(rows).toHaveLength(MAX_SESSION_ROWS);
    expect(rows[0].id).toBe(`s${MAX_SESSION_ROWS + 19}`);
  });

  it("is empty for anything but a list", () => {
    expect(sanitizeSessionRows({ data: [] })).toEqual([]);
    expect(sanitizeSessionRows(undefined)).toEqual([]);
  });
});

describe("limitImportedHistory", () => {
  it("keeps every turn under the limits, in order", () => {
    const history = limitImportedHistory([
      { user: "one", assistant: "1", providerTurnId: "t1", startedAt: 10 },
      { user: "two", providerTurnId: "bad id" },
      { user: "   " },
    ]);
    expect(history).toEqual({
      truncated: false,
      turns: [
        { user: "one", assistant: "1", providerTurnId: "t1", startedAt: 10 },
        { user: "two" },
      ],
    });
  });

  it("keeps the newest turns when there are too many", () => {
    const turns = Array.from({ length: MAX_IMPORTED_TURNS + 5 }, (_, i) => ({
      user: `u${i}`,
    }));
    const history = limitImportedHistory(turns);
    expect(history.truncated).toBe(true);
    expect(history.turns).toHaveLength(MAX_IMPORTED_TURNS);
    expect(history.turns[0].user).toBe("u5");
    expect(history.turns.at(-1)?.user).toBe(`u${MAX_IMPORTED_TURNS + 4}`);
  });

  it("caps one long message and the whole import", () => {
    const long = limitImportedHistory([{ user: "x".repeat(MAX_IMPORTED_TEXT + 10) }]);
    expect(long.truncated).toBe(true);
    expect(long.turns[0].user.length).toBe(MAX_IMPORTED_TEXT);

    const block = "y".repeat(MAX_IMPORTED_TEXT);
    const count = Math.ceil(MAX_IMPORTED_TOTAL / MAX_IMPORTED_TEXT) + 3;
    const total = limitImportedHistory(
      Array.from({ length: count }, () => ({ user: block })),
    );
    expect(total.truncated).toBe(true);
    const size = total.turns.reduce((sum, turn) => sum + turn.user.length, 0);
    expect(size).toBeLessThanOrEqual(MAX_IMPORTED_TOTAL);
  });

  it("passes on a truncation found earlier", () => {
    expect(limitImportedHistory([], true).truncated).toBe(true);
  });
});

describe("boundProviderSessions", () => {
  it("maps ids from open chats and saved history, for one harness", () => {
    const bound = boundProviderSessions(
      "codex",
      [
        { id: "m1", harness: "codex", providerSessionId: "thr_a" },
        { id: "m2", harness: "claude", providerSessionId: "thr_b" },
        { id: "m3", harness: "codex" },
      ],
      [
        { id: "m4", harness: "codex", providerSessionId: "thr_a" },
        { id: "m5", harness: "codex", providerSessionId: "thr_c", archived: true },
      ],
    );
    expect([...bound]).toEqual([
      ["thr_a", "m1"],
      ["thr_c", "m5"],
    ]);
  });
});

describe("pickedUpSession", () => {
  const base = { ...newSession("codex", "/repo", "gpt-5"), providerAccountId: "local" };
  const row = { id: "thr_1", title: "Fix the build", updatedAt: 1 };

  it("binds the chat to the session and copies its turns", () => {
    const session = pickedUpSession({
      base,
      row,
      harnessLabel: "Codex",
      history: {
        truncated: false,
        turns: [{ user: "hi", assistant: "hello", providerTurnId: "t1" }],
      },
    });
    expect(session.id).toBe(base.id);
    expect(session.providerSessionId).toBe("thr_1");
    expect(session.providerAccountId).toBe("local");
    expect(session.title).toBe("Fix the build");
    expect(session.blocks.map((block) => [block.role, block.text])).toEqual([
      ["system", "Picked up Codex session thr_1. Its earlier turns are shown below."],
      ["user", "hi"],
      ["assistant", "hello"],
    ]);
    // Rewind and fork at an imported prompt need the harness's turn id.
    expect(session.blocks[1].providerTurnId).toBe("t1");
  });

  it("opens with a notice only when the harness keeps the turns", () => {
    const session = pickedUpSession({
      base,
      row: { ...row, title: "" },
      harnessLabel: "Claude Code",
      history: null,
    });
    expect(session.blocks).toHaveLength(1);
    expect(session.blocks[0].text).toContain("Earlier turns are not shown here.");
    expect(session.title).toBe(base.title);
  });
});

describe("pickUpNotice", () => {
  it("says why turns are missing and when some were cut", () => {
    expect(
      pickUpNotice({
        harnessLabel: "Codex",
        providerSessionId: "t",
        history: null,
        reason: "Codex did not return them: thread not loaded.",
      }),
    ).toBe(
      "Picked up Codex session t. Earlier turns are not shown here. Codex did not return them: thread not loaded. The agent still has them.",
    );
    expect(
      pickUpNotice({
        harnessLabel: "Codex",
        providerSessionId: "t",
        history: { truncated: true, turns: [{ user: "a" }] },
      }),
    ).toContain("The newest 1 turns are shown");
    expect(
      pickUpNotice({
        harnessLabel: "Codex",
        providerSessionId: "t",
        history: { truncated: false, turns: [] },
      }),
    ).toContain("no earlier turns");
  });
});

describe("importedBlocks", () => {
  it("leaves out a missing reply", () => {
    const blocks = importedBlocks({ truncated: false, turns: [{ user: "q" }] });
    expect(blocks.map((block) => block.role)).toEqual(["user"]);
  });
});

describe("rowAge", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  it("reads as a short age", () => {
    expect(rowAge(0, now)).toBe("");
    expect(rowAge(now - 5_000, now)).toBe("just now");
    expect(rowAge(now - 3 * 60_000, now)).toBe("3 min ago");
    expect(rowAge(now - 5 * 3_600_000, now)).toBe("5 h ago");
    expect(rowAge(now - 30 * 3_600_000, now)).toBe("yesterday");
    expect(rowAge(now - 4 * 86_400_000, now)).toBe("4 days ago");
    expect(rowAge(now - 60 * 86_400_000, now)).toBe("2026-08-13");
  });
});
