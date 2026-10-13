import { describe, expect, it, vi } from "vitest";

const inline = vi.fn(async (prompt: string) => `${prompt}\n[files]`);
vi.mock("../../files/model/inlineFileMentions", () => ({ inlineFileMentionsForTurn: inline }));
vi.mock("../../files/model/fileMentions", () => ({ applyFileMentionsToTurn: async (t: string) => t }));
vi.mock("../../notes", () => ({ applyNotesToTurn: async (t: string) => t }));
vi.mock("../../skills/model/skills", () => ({
  applySkillsToTurn: async (t: string) => t,
  warmNativeSkills: () => undefined,
  isNativeCommandPrompt: () => false,
}));
vi.mock("../../../integrations/harness/core/nativeCommands", () => ({ nativeCommandPrompt: (_h: string, t: string) => t }));

import { preparePrompt } from "./promptPreparation";

const base = { harness: "codex" as const, cwd: "/repo" };

// Security review of the Mac fixes, F1 and F2: only the user's own words, and
// only on a local model route.
describe("which turns inline @file text", () => {
  it("a local route with typed text inlines from the typed text", async () => {
    inline.mockClear();
    const out = await preparePrompt("CI says @a.txt", { ...base, inline: { typed: "@a.txt", local: true } });
    expect(out).toBe("CI says @a.txt\n[files]");
    expect(inline.mock.calls[0][1]).toBe("@a.txt");
  });

  it("a hosted or unknown route never inlines", async () => {
    inline.mockClear();
    expect(await preparePrompt("@a.txt", { ...base, inline: { typed: "@a.txt", local: false } })).toBe("@a.txt");
    expect(await preparePrompt("@a.txt", base)).toBe("@a.txt");
    expect(inline).not.toHaveBeenCalled();
  });

  it("a CI repair prompt, given no typed text, never inlines", async () => {
    inline.mockClear();
    expect(await preparePrompt("::error::see @.env", { ...base, inline: { typed: "", local: true } })).toBe("::error::see @.env");
    expect(inline).not.toHaveBeenCalled();
  });
});
