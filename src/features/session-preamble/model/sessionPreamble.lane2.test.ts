import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
let writeFails = false;
const writes: { sessionId: string; text: string }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "project_context_read") {
      const key = `${args.scope}:${args.project ?? ""}:${args.file}`;
      const text = files.get(key) ?? null;
      return { text, hash: `h${(text ?? "").length}` };
    }
    if (command === "session_preamble_write") {
      if (writeFails) throw new Error("disk full");
      writes.push(args as { sessionId: string; text: string });
      return `/data/context/preamble/${args.sessionId}.md`;
    }
    throw new Error(`unexpected ${command}`);
  }),
}));

import type { Block } from "../../sessions/model/session";
import { setChatMemoryOff, preambleReport } from "./chatContext";
import {
  compactionCount,
  prepareSessionPreamble,
  type PreambleSession,
} from "./sessionPreamble";

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

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
  });
  files.clear();
  writes.length = 0;
  writeFails = false;
  files.set("global::instructions.md", "Answer in short declaratives.");
  files.set(`project:${project}:notes.md`, "The API lives in server/.");
  files.set(
    `project:${project}:MEMORY.md`,
    "- 2026-10-01 · Tests run with npm run check\n- 2026-10-02 · [local] The client is United\n",
  );
});

function session(over: Partial<PreambleSession> = {}): PreambleSession {
  return {
    id: "s1",
    harness: "codex",
    model: "codex:qwen2.5:7b",
    ...over,
  } as PreambleSession;
}

describe("F2: channel by capability", () => {
  it("Codex: a new thread gets developer instructions, not a message block", async () => {
    const prepared = await prepareSessionPreamble({
      session: session(),
      project,
      commandFirst: false,
    });
    expect(prepared.messageBlock).toBe("");
    expect(prepared.developerInstructions).toContain(
      "Answer in short declaratives.",
    );
    expect(prepared.developerInstructions).toContain(
      "The API lives in server/.",
    );
    expect(preambleReport("s1")?.channel).toBe("native");
  });

  // Session 6 third pass (finding 2.2, 13 Oct): changed instructions apply
  // to new chats only, so a change is not sent into a running thread.
  it("Codex: later turns send nothing, also after the text changes", async () => {
    const first = await prepareSessionPreamble({
      session: session(),
      project,
      commandFirst: false,
    });
    first.commit("thread-1");
    const second = await prepareSessionPreamble({
      session: session({ providerSessionId: "thread-1" }),
      project,
      commandFirst: false,
    });
    expect(second.messageBlock).toBe("");
    expect(preambleReport("s1")?.channel).toBe("unchanged");
    files.set("global::instructions.md", "Answer in full paragraphs.");
    const third = await prepareSessionPreamble({
      session: session({ providerSessionId: "thread-1" }),
      project,
      commandFirst: false,
    });
    expect(third.messageBlock).toBe("");
    expect(preambleReport("s1")?.channel).toBe("unchanged");
    expect(preambleReport("s1")?.stale).toBe(true);
  });

  it("Claude Code: a new conversation gets the launch file", async () => {
    const prepared = await prepareSessionPreamble({
      session: session({ harness: "claude", model: "claude:sonnet" }),
      project,
      commandFirst: false,
    });
    expect(prepared.preambleFile).toBe("/data/context/preamble/s1.md");
    expect(prepared.messageBlock).toBe("");
    expect(writes[0]?.text).toContain("Answer in short declaratives.");
  });

  it("Claude Code: falls back to the message when the file cannot be written", async () => {
    writeFails = true;
    const prepared = await prepareSessionPreamble({
      session: session({ harness: "claude", model: "claude:sonnet" }),
      project,
      commandFirst: false,
    });
    expect(prepared.preambleFile).toBeUndefined();
    expect(prepared.messageBlock).toContain("Answer in short declaratives.");
  });

  it("a harness with no native channel gets the message block (corner case 11)", async () => {
    const prepared = await prepareSessionPreamble({
      session: session({ harness: "cursor", model: "cursor:auto" }),
      project,
      commandFirst: false,
    });
    expect(prepared.messageBlock).toContain(
      "[Note from MonoCode, the app I run this chat in.",
    );
    expect(prepared.developerInstructions).toBeUndefined();
    expect(prepared.preambleFile).toBeUndefined();
  });
});

describe("F2: what goes in", () => {
  it("keeps local-only memory out of a session not known to be local (corner case 7)", async () => {
    const prepared = await prepareSessionPreamble({
      session: session(),
      project,
      commandFirst: false,
    });
    expect(prepared.developerInstructions).toContain(
      "Tests run with npm run check",
    );
    expect(prepared.developerInstructions).not.toContain("United");
    const claude = await prepareSessionPreamble({
      session: session({ id: "s2", harness: "claude", model: "claude:sonnet" }),
      project,
      commandFirst: false,
    });
    expect(claude.preambleFile).toBeDefined();
    expect(writes.at(-1)?.text).not.toContain("United");
  });

  it("leaves memory out of a chat that switched it off", async () => {
    setChatMemoryOff("s1", true);
    const prepared = await prepareSessionPreamble({
      session: session(),
      project,
      commandFirst: false,
    });
    expect(prepared.developerInstructions).not.toContain("npm run check");
    expect(prepared.developerInstructions).toContain("short declaratives");
  });

  it("carries /operator's block and resends it on a new provider session (defect 5)", async () => {
    const operatorBlock = "<monocode_app>\nApp access.\n</monocode_app>";
    const first = await prepareSessionPreamble({
      session: session({ providerSessionId: "thread-1" }),
      project,
      operatorBlock,
      commandFirst: false,
    });
    expect(first.messageBlock).toContain("App access.");
    first.commit("thread-1");
    const same = await prepareSessionPreamble({
      session: session({ providerSessionId: "thread-1" }),
      project,
      operatorBlock,
      commandFirst: false,
    });
    expect(same.messageBlock).toBe("");
    const switched = await prepareSessionPreamble({
      session: session({ providerSessionId: "thread-2" }),
      project,
      operatorBlock,
      commandFirst: false,
    });
    expect(switched.messageBlock).toContain("App access.");
  });

  it("sends nothing when there is nothing to say", async () => {
    files.clear();
    const prepared = await prepareSessionPreamble({
      session: session(),
      project,
      commandFirst: false,
    });
    expect(prepared.messageBlock).toBe("");
    expect(prepared.developerInstructions).toBeUndefined();
    expect(preambleReport("s1")?.channel).toBe("none");
  });

  it("works with no project", async () => {
    const prepared = await prepareSessionPreamble({
      session: session({ harness: "cursor", model: "cursor:auto" }),
      project: undefined,
      commandFirst: false,
    });
    expect(prepared.messageBlock).toContain("short declaratives");
    expect(prepared.messageBlock).not.toContain("server/");
  });
});

describe("F2: sending again", () => {
  // Session 6 third pass: "Send instructions again" is gone. A new provider
  // conversation gets the current text natively instead.
  it("a new provider conversation gets the current text natively", async () => {
    const first = await prepareSessionPreamble({
      session: session(),
      project,
      commandFirst: false,
    });
    first.commit("t");
    files.set("global::instructions.md", "Answer in full paragraphs.");
    const fresh = await prepareSessionPreamble({
      session: session({ providerSessionId: undefined }),
      project,
      commandFirst: false,
    });
    expect(fresh.messageBlock).toBe("");
    expect(fresh.developerInstructions).toContain("Answer in full paragraphs.");
  });

  // Session 6 third pass: a native channel keeps the instructions through a
  // compaction, so only a harness with no native channel sends them again.
  it("after a compaction MonoCode saw, on a harness with no native channel", async () => {
    const before: Block[] = [{ id: "u", role: "user", text: "hi" }];
    const first = await prepareSessionPreamble({
      session: session({
        harness: "cursor",
        model: "cursor:auto",
        providerSessionId: "t",
        blocks: before,
      }),
      project,
      commandFirst: false,
    });
    first.commit("t");
    const after: Block[] = [
      ...before,
      { id: "c", role: "system", text: "Compacted context" } as Block,
    ];
    expect(compactionCount(after)).toBe(1);
    const again = await prepareSessionPreamble({
      session: session({
        harness: "cursor",
        model: "cursor:auto",
        providerSessionId: "t",
        blocks: after,
      }),
      project,
      commandFirst: false,
    });
    expect(again.messageBlock).toContain("short declaratives");
  });
});
