import { describe, expect, it } from "vitest";
import type { Block } from "../../sessions/model/session";
import {
  conversationToMarkdown,
  exportFileName,
  fenced,
  type ExportableSession,
} from "./exportMarkdown";

const NOW = new Date("2026-10-12T06:00:00.000Z");

function session(blocks: Block[]): ExportableSession {
  return {
    title: "Fix the flaky test",
    harness: "codex",
    model: "qwen2.5:7b",
    cwd: "/Users/ada/codex-scratch",
    blocks,
  };
}

const turn: Block[] = [
  { id: "u1", role: "user", text: "Run the tests", sentAt: Date.parse("2026-10-11T20:00:00Z") },
  { id: "r1", role: "reasoning", text: "Check the runner first." },
  {
    id: "t1",
    role: "tool",
    text: "npm test",
    tool: { title: "npm test", status: "completed", detail: "12 passed\n0 failed" },
  },
  {
    id: "a1",
    role: "assistant",
    text: "All 12 pass.",
    turnModel: { harness: "codex", id: "qwen2.5:7b", name: "Qwen2.5 7B (local)" },
  },
];

describe("conversationToMarkdown (#29)", () => {
  it("writes a header, your message, folded work and the reply in order", () => {
    const md = conversationToMarkdown(session(turn), { now: NOW });
    expect(md.startsWith("# Fix the flaky test\n")).toBe(true);
    expect(md).toContain("- Exported: 2026-10-12T06:00:00.000Z");
    expect(md).toContain("- Started on: Codex, qwen2.5:7b");
    const you = md.indexOf("## You · 2026-10-11T20:00:00.000Z");
    const work = md.indexOf("<summary>Work: 2 steps</summary>");
    const reply = md.indexOf("### Codex · Qwen2.5 7B (local)");
    expect(you).toBeGreaterThan(0);
    expect(work).toBeGreaterThan(you);
    expect(reply).toBeGreaterThan(work);
    expect(md).toContain("> Check the runner first.");
    expect(md).toContain("```text\n12 passed\n0 failed\n```");
    expect(md.endsWith("All 12 pass.\n")).toBe(true);
  });

  it("leaves out internal and draft blocks", () => {
    const md = conversationToMarkdown(
      session([
        ...turn,
        { id: "i", role: "user", text: "SECRET operator block", internal: true },
        { id: "d", role: "user", text: "unsent draft", draft: true },
      ]),
      { now: NOW },
    );
    expect(md).not.toContain("SECRET");
    expect(md).not.toContain("unsent draft");
  });

  it("keeps tool output that holds backticks inside its fence", () => {
    const detail = "before\n```\ninjected\n```\nafter";
    const md = conversationToMarkdown(
      session([{ id: "t", role: "tool", text: "cat", tool: { detail } }]),
      { now: NOW },
    );
    expect(md).toContain("````text\nbefore");
    expect(md).toContain("after\n````");
  });

  it("cuts long tool output and says how much", () => {
    const md = conversationToMarkdown(
      session([{ id: "t", role: "tool", text: "log", tool: { detail: "x".repeat(50) } }]),
      { now: NOW, maxToolDetail: 10 },
    );
    expect(md).toContain("… 40 more characters left out");
  });

  it("writes plans and task lists", () => {
    const md = conversationToMarkdown(
      session([
        { id: "p", role: "plan", text: "1. Read\n2. Fix", plan: { status: "approved" } as never },
        {
          id: "k",
          role: "tasks",
          text: "",
          taskList: {
            items: [
              { text: "Read", status: "completed" },
              { text: "Fix", status: "in_progress" },
            ],
          },
        },
      ]),
      { now: NOW },
    );
    expect(md).toContain("### Plan (approved)");
    expect(md).toContain("- [x] Read");
    expect(md).toContain("- [ ] Fix _(in progress)_");
  });

  it("puts error notices inside the work, not as a reply", () => {
    const md = conversationToMarkdown(
      session([
        { id: "u", role: "user", text: "go" },
        { id: "e", role: "assistant", text: "workspace routing discovery failed", notice: "error" },
      ]),
      { now: NOW },
    );
    expect(md).toContain("**Error**");
    expect(md).not.toContain("### Assistant");
  });

  it("exports an empty or untitled conversation without failing", () => {
    const md = conversationToMarkdown({ ...session([]), title: "  " }, { now: NOW });
    expect(md.startsWith("# Untitled conversation")).toBe(true);
  });

  it("handles a long chat quickly", () => {
    const blocks: Block[] = [];
    for (let index = 0; index < 2000; index += 1) {
      blocks.push(
        { id: `u${index}`, role: "user", text: `question ${index}` },
        { id: `t${index}`, role: "tool", text: "ls", tool: { detail: "a\nb\nc" } },
        { id: `a${index}`, role: "assistant", text: `answer ${index}` },
      );
    }
    const started = performance.now();
    const md = conversationToMarkdown(session(blocks), { now: NOW });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(md).toContain("answer 1999");
  });
});

describe("fenced and exportFileName", () => {
  it("uses at least three backticks", () => {
    expect(fenced("plain")).toBe("```text\nplain\n```");
  });

  it("makes a safe file name from any title", () => {
    // The name carries the local date (Mac finding 3.11), so this uses local
    // noon, which is the same day in every time zone the suite runs in.
    const NOW = new Date(2026, 9, 12, 12, 0, 0);
    expect(exportFileName("Fix: the ../../etc/passwd bug!", NOW)).toBe(
      "Fix the etcpasswd bug 2026-10-12.md",
    );
    expect(exportFileName("-rf", NOW)).toBe("rf 2026-10-12.md");
    expect(exportFileName("", NOW)).toBe("conversation 2026-10-12.md");
    // Late evening local time is still that day, not the UTC day after.
    expect(exportFileName("x", new Date(2026, 9, 12, 23, 30))).toBe("x 2026-10-12.md");
  });
});
