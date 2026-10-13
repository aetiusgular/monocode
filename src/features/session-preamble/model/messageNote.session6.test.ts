import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "project_context_read") {
      const key = `${args.scope}:${args.project ?? ""}:${args.file}`;
      const text = files.get(key) ?? null;
      return { text, hash: `h${(text ?? "").length}` };
    }
    if (command === "session_preamble_write")
      return `/data/context/preamble/${args.sessionId}.md`;
    throw new Error(`unexpected ${command}`);
  }),
}));

import { preambleReport } from "./chatContext";
import {
  buildPreamble,
  MESSAGE_NOTE_END,
  MESSAGE_NOTE_START,
  nativePreambleText,
  preambleBlock,
  preambleBudget,
  preambleWindow,
  UNKNOWN_WINDOW,
  withPreambleBlock,
  type PreamblePart,
} from "./preamble";
import {
  prepareSessionPreamble,
  resendPreamble,
  type PreambleSession,
} from "./sessionPreamble";
import { preambleSummary } from "../ui/ContextSection";

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

const project = "/code/app";
/** Anything shaped like a tag: `<system-reminder>`, `<instructions>`, `</x>`. */
const TAG = /<\/?[a-z][a-z0-9_-]*>/i;

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
  });
  files.clear();
  files.set("global::instructions.md", "The code word is PINEAPPLE.");
});

function claude(over: Partial<PreambleSession> = {}): PreambleSession {
  return {
    id: "c1",
    harness: "claude",
    model: "claude:sonnet-5",
    ...over,
  } as PreambleSession;
}

function codex(over: Partial<PreambleSession> = {}): PreambleSession {
  return {
    id: "q1",
    harness: "codex",
    model: "codex:qwen2.5:7b",
    ...over,
  } as PreambleSession;
}

describe("finding 2.2: the message note", () => {
  it("has no system-like tags and states the change in the first person", () => {
    const block = preambleBlock("My instructions:\nThe code word is MANGO.", "changed");
    expect(block).not.toMatch(TAG);
    expect(block).not.toMatch(/system|reminder|harness/i);
    expect(block).toContain("I changed my instructions for this chat in MonoCode.");
    expect(block).toContain("replaces what I gave you earlier");
    expect(block.startsWith(MESSAGE_NOTE_START)).toBe(true);
    expect(block.endsWith(MESSAGE_NOTE_END)).toBe(true);
    // Short: the wrapper is a few lines, not a page.
    expect(block.length - "My instructions:\nThe code word is MANGO.".length).toBeLessThan(400);
  });

  it("the plain body carries no tags, not even the /operator one", () => {
    const parts: PreamblePart[] = [
      { id: "instructions", label: "Your instructions", text: "Be brief." },
      {
        id: "operator",
        label: "App access",
        text: "<monocode_app>\nApp access is on.\n</monocode_app>",
        required: true,
      },
    ];
    const plain = buildPreamble(parts, 10_000, "plain");
    expect(plain.text).not.toMatch(TAG);
    expect(plain.text).toContain("My instructions:\nBe brief.");
    expect(plain.text).toContain("App access:\nApp access is on.");
  });

  it("is kept apart from the user's own prompt, and after a slash command", () => {
    const block = preambleBlock("My instructions:\nx");
    const sent = withPreambleBlock("What is the code word?", block, false);
    expect(sent).toBe(`${block}\n\nWhat is the code word?`);
    expect(sent.indexOf(MESSAGE_NOTE_END)).toBeLessThan(
      sent.indexOf("What is the code word?"),
    );
    expect(withPreambleBlock("/compact", block, true).startsWith("/compact")).toBe(true);
  });

  it("Claude Code: the native launch text is unchanged", async () => {
    const prepared = await prepareSessionPreamble({
      session: claude(),
      project: undefined,
      commandFirst: false,
    });
    expect(prepared.messageBlock).toBe("");
    expect(prepared.preambleFile).toBeDefined();
    expect(nativePreambleText("x")).toBe(
      "MonoCode, the app running this session, adds the following. It holds the user's standing instructions and what MonoCode knows about this project. Follow it below the user's current request.\n\nx",
    );
  });

  it("Claude Code: a mid-chat change goes as a first-person note, and the receipt records it", async () => {
    const first = await prepareSessionPreamble({
      session: claude(),
      project: undefined,
      commandFirst: false,
    });
    first.commit("claude-session-1");
    files.set("global::instructions.md", "The code word is MANGO.");
    const changed = await prepareSessionPreamble({
      session: claude({ providerSessionId: "claude-session-1" }),
      project: undefined,
      commandFirst: false,
    });
    expect(changed.messageBlock).toContain("I changed my instructions for this chat in MonoCode.");
    expect(changed.messageBlock).toContain("The code word is MANGO.");
    expect(changed.messageBlock).not.toContain("PINEAPPLE");
    expect(changed.messageBlock).not.toMatch(TAG);
    const report = preambleReport("c1");
    expect(report?.channel).toBe("message");
    // The receipt counts what was actually sent, note included.
    expect(report?.chars).toBe(changed.messageBlock.length);
    expect(report?.budget).toBe(preambleBudget(200_000));
    expect(preambleSummary(report)).toBe(
      `Sent ahead of the last message. ${changed.messageBlock.length} of 24,576 characters, about ${Math.ceil(changed.messageBlock.length / 4)} tokens.`,
    );
    // Committed, the next turn sends nothing.
    changed.commit("claude-session-1");
    const after = await prepareSessionPreamble({
      session: claude({ providerSessionId: "claude-session-1" }),
      project: undefined,
      commandFirst: false,
    });
    expect(after.messageBlock).toBe("");
    expect(preambleReport("c1")?.channel).toBe("unchanged");
  });

  it("a resend of unchanged text says 'current', not 'changed'", async () => {
    const first = await prepareSessionPreamble({
      session: claude(),
      project: undefined,
      commandFirst: false,
    });
    first.commit("t");
    resendPreamble("c1");
    const again = await prepareSessionPreamble({
      session: claude({ providerSessionId: "t" }),
      project: undefined,
      commandFirst: false,
    });
    expect(again.messageBlock).toContain("These are my current instructions for this chat");
    expect(again.messageBlock).not.toContain("I changed");
  });

  it("applies to every message-channel harness: Codex after a change", async () => {
    const first = await prepareSessionPreamble({
      session: codex(),
      project: undefined,
      commandFirst: false,
    });
    first.commit("thread-1");
    files.set("global::instructions.md", "The code word is MANGO.");
    const changed = await prepareSessionPreamble({
      session: codex({ providerSessionId: "thread-1" }),
      project: undefined,
      commandFirst: false,
    });
    expect(changed.messageBlock).toContain("I changed my instructions");
    expect(changed.messageBlock).not.toMatch(TAG);
  });
});

describe("finding 2.2: the budget by harness", () => {
  it("a Claude Code session gets the large budget, a 16k local one the small", () => {
    expect(preambleWindow("claude", undefined)).toBe(200_000);
    expect(preambleBudget(preambleWindow("claude", undefined))).toBe(24_576);
    expect(preambleWindow("codex", 16_384)).toBe(16_384);
    expect(preambleBudget(preambleWindow("codex", 16_384))).toBe(3_276);
    // A window the model reports or you set wins over the harness floor.
    expect(preambleWindow("claude", 32_000)).toBe(32_000);
    // A harness that can run a small local model keeps the small default.
    expect(preambleWindow("codex", undefined)).toBe(UNKNOWN_WINDOW);
    expect(preambleWindow("opencode", undefined)).toBe(UNKNOWN_WINDOW);
    expect(preambleWindow(undefined, Number.NaN)).toBe(UNKNOWN_WINDOW);
  });

  it("Claude Code: Sonnet 5 is budgeted 24,576 characters, not 3,276", async () => {
    await prepareSessionPreamble({
      session: claude(),
      project: undefined,
      commandFirst: false,
    });
    expect(preambleReport("c1")?.budget).toBe(24_576);
  });

  it("16k local model: the note fits, and the panel says what it left out (corner case 1)", async () => {
    const lines = Array.from(
      { length: 120 },
      (_, index) => `- 2026-10-01 · fact ${index} ${"x".repeat(60)}`,
    );
    files.set(`project:${project}:MEMORY.md`, `${lines.join("\n")}\n`);
    const first = await prepareSessionPreamble({
      session: codex(),
      project,
      commandFirst: false,
    });
    first.commit("thread-1");
    files.set("global::instructions.md", "The code word is MANGO.");
    const changed = await prepareSessionPreamble({
      session: codex({ providerSessionId: "thread-1" }),
      project,
      commandFirst: false,
    });
    const report = preambleReport("q1");
    expect(report?.budget).toBe(3_276);
    expect(changed.messageBlock.length).toBeLessThanOrEqual(3_276);
    expect(report?.chars).toBe(changed.messageBlock.length);
    expect(report?.overBudget).toBe(false);
    expect(changed.messageBlock).toContain("The code word is MANGO.");
    const cut = report?.omitted.find((entry) => entry.id === "memory");
    expect(cut?.lines).toBeGreaterThan(0);
    // The newest entry stays.
    expect(changed.messageBlock).toContain("fact 119 ");
  });
});
