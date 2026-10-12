import { describe, expect, it } from "vitest";
import { appBlock } from "./appBlock";

const cli = "/Applications/MonoCode.app/Contents/MacOS/monocode app";

describe("F7: the monocode_app block", () => {
  it("points at help per action instead of the whole usage text", () => {
    const text = appBlock({ cli, alwaysEnabled: false });
    expect(text.startsWith("<monocode_app>\n")).toBe(true);
    expect(text.endsWith("\n</monocode_app>")).toBe(true);
    expect(text).toContain(`${cli} help <action>`);
    expect(text).toContain(`${cli} help sessions.start`);
    expect(text).toContain("Operator command");
    expect(text).toContain("never print it");
    expect(text).not.toContain("memory");
  });

  it("stays small for a 16k local model (corner case 1)", () => {
    // About 300 tokens; the whole app --help is about 2,500.
    expect(
      appBlock({ cli, alwaysEnabled: true, memory: true }).length,
    ).toBeLessThan(2_100);
  });

  it("names memory only when the thread has project memory", () => {
    const text = appBlock({ cli, alwaysEnabled: true, memory: true });
    expect(text).toContain("always enabled");
    expect(text).toContain("sessions, worktrees, folders, notes, memory");
    expect(text).toContain("waits for the user's approval");
  });
});
