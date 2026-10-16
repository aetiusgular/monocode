import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    const key = `${args.project ?? ""}:${args.file}`;
    if (command === "project_context_read") {
      const text = store.get(key) ?? null;
      return { text, hash: `h:${text ?? ""}` };
    }
    if (command === "project_context_save") {
      store.set(key, String(args.text));
      return `h:${args.text}`;
    }
    throw new Error(command);
  }),
}));

import { MEMORY_ENTRY_MAX } from "../../monos/model/monoMemory";
import { REMEMBER_MAX, rememberableText, rememberText } from "./remember";

// Mac 2.8: Remember this saves the whole selection or nothing; it never cuts.

const project = "/code/app";
const memory = () => store.get(`${project}:MEMORY.md`) ?? "";

beforeEach(() => store.clear());

describe("Remember this never cuts", () => {
  it("keeps the limit inside one memory entry with room for the local mark", () => {
    expect(REMEMBER_MAX).toBeLessThan(MEMORY_ENTRY_MAX);
    expect(REMEMBER_MAX + "[local] ".length).toBeLessThanOrEqual(
      MEMORY_ENTRY_MAX,
    );
  });

  it("saves a selection at the limit whole", async () => {
    const text = `${"a".repeat(REMEMBER_MAX - 4)} end`;
    expect(rememberableText(text)).toBe(text);
    await rememberText(project, text, { harness: "codex" });
    expect(memory()).toContain(text);
  });

  it("refuses a longer selection, names the limit and saves nothing", async () => {
    const text = "x".repeat(REMEMBER_MAX + 1);
    expect(() => rememberableText(text)).toThrow(
      `This selection is 981 characters. A memory entry holds at most ${REMEMBER_MAX}.`,
    );
    await expect(
      rememberText(project, text, { harness: "codex" }),
    ).rejects.toThrow(/at most 980/);
    expect(memory()).toBe("");
  });

  it("counts after folding spaces, as the entry is stored", () => {
    // 1,300 characters as selected, 975 once line breaks fold to spaces.
    const text = "ab\n\n".repeat(325);
    expect(text.length).toBeGreaterThan(REMEMBER_MAX);
    expect(rememberableText(text)).toBe("ab ".repeat(325).trim());
  });
});
