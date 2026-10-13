import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const prompts: Record<string, unknown>[] = [];
let reply: string | Error = "";
let canPrompt = true;

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
vi.mock("../../../integrations/harness/core/registry", () => ({
  canRunHarnessTextPrompt: () => canPrompt,
  runHarnessTextPrompt: vi.fn(async (input: Record<string, unknown>) => {
    prompts.push(input);
    if (reply instanceof Error) throw reply;
    return reply;
  }),
}));

import type { Block } from "../../sessions/model/session";
import {
  resetTraitOverridesCache,
  saveTraitOverride,
} from "../../model-traits/model/modelTraits";
import { loadProposals } from "./proposals";
import {
  parseSuggestions,
  suggestMemories,
  SUGGEST_TIMEOUT_MS,
  transcriptExcerpt,
} from "./suggest";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

beforeEach(() => {
  store.clear();
  prompts.length = 0;
  reply = "";
  canPrompt = true;
  resetTraitOverridesCache();
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
  });
});

const blocks: Block[] = [
  { id: "1", role: "user", text: "Use pnpm, not npm." },
  { id: "2", role: "tool", text: "ls" } as Block,
  { id: "3", role: "assistant", text: "Done. Switched the scripts to pnpm." },
];

const session = {
  id: "s1",
  cwd: "/code/app",
  harness: "codex" as const,
  model: "codex:qwen2.5:7b",
  providerAccountId: "local",
  blocks,
};

describe("#36: Suggest memories", () => {
  it("parses plain lines loosely and drops junk", () => {
    expect(
      parseSuggestions(
        "Here you go:\n- Uses pnpm\n* **Tests in vitest**\n2) Deploy on Fridays\nprose line\n- Uses pnpm",
      ),
    ).toEqual(["Uses pnpm", "Tests in vitest", "Deploy on Fridays"]);
    expect(parseSuggestions("NONE")).toEqual([]);
    expect(parseSuggestions("- none")).toEqual([]);
    expect(parseSuggestions(`- ${"x".repeat(2000)}`)).toEqual([]);
    expect(
      parseSuggestions(
        Array.from({ length: 9 }, (_, i) => `- f${i}`).join("\n"),
      ),
    ).toHaveLength(5);
  });

  it("keeps the newest user and agent text that fits", () => {
    expect(transcriptExcerpt(blocks, 10_000)).toBe(
      "User: Use pnpm, not npm.\n\nAgent: Done. Switched the scripts to pnpm.",
    );
    expect(transcriptExcerpt(blocks, 50)).toBe(
      "Agent: Done. Switched the scripts to pnpm.",
    );
    expect(transcriptExcerpt([], 100)).toBe("");
  });

  it("runs on the session's own harness, account and model (rule 6)", async () => {
    reply = "- Uses pnpm";
    const result = await suggestMemories(session);
    expect(result).toMatchObject({ ok: true });
    expect(prompts[0]).toMatchObject({
      harness: "codex",
      cwd: "/code/app",
      providerAccountId: "local",
      model: "qwen2.5:7b",
    });
    expect(String(prompts[0].prompt)).toContain("Use pnpm, not npm.");
    expect((await loadProposals("/code/app"))[0]).toMatchObject({
      fact: "Uses pnpm",
      source: "suggested",
    });
  });

  it("fits a small window (corner case 1) and stretches the timeout for a slow model (corner case 3)", async () => {
    saveTraitOverride("codex:qwen2.5:7b", { contextWindow: 16384, slow: true });
    const long: Block[] = Array.from({ length: 200 }, (_, index) => ({
      id: String(index),
      role: index % 2 ? "assistant" : "user",
      text: "y".repeat(500),
    }));
    reply = "NONE";
    await suggestMemories({ ...session, blocks: long });
    expect(String(prompts[0].prompt).length).toBeLessThan(
      16_384 * 0.4 * 4 + 1_000,
    );
    expect(prompts[0].timeoutMs).toBe(SUGGEST_TIMEOUT_MS * 4);
  });

  it("fails without hanging when the model gives nothing (corner case 2)", async () => {
    reply = new Error("empty reply");
    expect(await suggestMemories(session)).toEqual({
      ok: false,
      reason: "The model did not answer: empty reply",
    });
    expect(await loadProposals("/code/app")).toEqual([]);
    reply = "";
    expect(await suggestMemories(session)).toEqual({ ok: true, proposals: [] });
  });

  it("says why when it cannot run", async () => {
    canPrompt = false;
    expect(
      (await suggestMemories(session)) as { reason: string },
    ).toMatchObject({ ok: false });
    canPrompt = true;
    expect(await suggestMemories({ ...session, blocks: [] })).toEqual({
      ok: false,
      reason: "Nothing in this chat yet.",
    });
    expect(await suggestMemories({ ...session, cwd: "~" })).toMatchObject({
      ok: false,
    });
    expect(SUGGEST_TIMEOUT_MS).toBe(60_000);
  });
});
