import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
const writes: { sessionId: string; text: string }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "project_context_read") {
      const key = `${args.scope}:${args.project ?? ""}:${args.file}`;
      const text = files.get(key) ?? null;
      return { text, hash: `h${(text ?? "").length}` };
    }
    if (command === "session_preamble_write") {
      writes.push(args as { sessionId: string; text: string });
      return `/data/context/preamble/${args.sessionId}.md`;
    }
    if (command === "session_preamble_forget") return null;
    throw new Error(`unexpected ${command}`);
  }),
}));
vi.mock("../../../platform/tauri/fs", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readTextFile: vi.fn(async () => {
    throw new Error("missing");
  }),
}));

import type { Block } from "../../sessions/model/session";
import { preambleReport } from "./chatContext";
import { preambleBudget } from "./preamble";
import { instructionsStale } from "./receipts";
import {
  forgetSessionContext,
  instructionsStaleNow,
  prepareSessionPreamble,
  type PreambleSession,
} from "./sessionPreamble";
import {
  NEW_CHAT_WITH_THESE,
  STALE_INSTRUCTIONS_TEXT,
  StaleInstructionsView,
} from "../ui/StaleInstructionsLine";
import { acceptedNote, preambleSummary } from "../ui/ContextSection";

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
const operatorBlock = "<monocode_app>\nApp access is on.\n</monocode_app>";

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
  });
  files.clear();
  writes.length = 0;
  files.set("global::instructions.md", "The code word is PINEAPPLE.");
  files.set(`project:${project}:notes.md`, "The API lives in server/.");
  files.set(
    `project:${project}:MEMORY.md`,
    "- 2026-10-01 · Tests run with npm run check\n- 2026-10-02 · [local] The client is United\n",
  );
});

let next = 0;
function chat(
  harness: string,
  over: Partial<PreambleSession> = {},
): PreambleSession {
  const model =
    harness === "claude"
      ? "claude:sonnet-5"
      : harness === "codex"
        ? "codex:qwen2.5:7b"
        : "cursor:auto";
  return {
    id: `${harness}-${next++}`,
    harness,
    model,
    ...over,
  } as PreambleSession;
}

async function turn(
  session: PreambleSession,
  provider: string | undefined,
  extra: { operatorBlock?: string; blocks?: Block[] } = {},
) {
  const prepared = await prepareSessionPreamble({
    session: { ...session, providerSessionId: provider, blocks: extra.blocks },
    project,
    operatorBlock: extra.operatorBlock,
    commandFirst: false,
  });
  return prepared;
}

describe("finding 2.2 (13 Oct): changed instructions apply to new chats only", () => {
  for (const harness of ["claude", "codex"]) {
    it(`${harness}: a started conversation gets nothing after a change, and is stale`, async () => {
      const session = chat(harness);
      const first = await turn(session, undefined);
      expect(first.messageBlock).toBe("");
      first.commit("p1");
      expect(instructionsStale(session.id, "p1", "x")).toBe(true);
      files.set("global::instructions.md", "The code word is MANGO.");
      const changed = await turn(session, "p1");
      expect(changed.messageBlock).toBe("");
      expect(preambleReport(session.id)?.stale).toBe(true);
      expect(preambleReport(session.id)?.channel).toBe("unchanged");
      changed.commit("p1");
      // Still stale after the commit: the start hash is kept.
      expect(
        await instructionsStaleNow(
          { id: session.id, providerSessionId: "p1" },
          project,
        ),
      ).toBe(true);
      // Project notes count too.
      files.set("global::instructions.md", "The code word is PINEAPPLE.");
      expect(
        await instructionsStaleNow(
          { id: session.id, providerSessionId: "p1" },
          project,
        ),
      ).toBe(false);
      files.set(`project:${project}:notes.md`, "The API moved to api/.");
      expect(
        await instructionsStaleNow(
          { id: session.id, providerSessionId: "p1" },
          project,
        ),
      ).toBe(true);
    });
  }

  it("a memory change alone does not raise the stale line", async () => {
    const session = chat("claude");
    (await turn(session, undefined)).commit("p1");
    files.set(
      `project:${project}:MEMORY.md`,
      "- 2026-10-03 · Deploys go through CI\n",
    );
    const after = await turn(session, "p1");
    expect(after.messageBlock).toBe("");
    expect(preambleReport(session.id)?.stale).toBe(false);
  });

  it("Claude Code: a new provider conversation gets the new text natively", async () => {
    const session = chat("claude");
    (await turn(session, undefined)).commit("p1");
    files.set("global::instructions.md", "The code word is MANGO.");
    const fresh = await turn(session, undefined);
    expect(fresh.messageBlock).toBe("");
    expect(fresh.preambleFile).toBeDefined();
    expect(writes.at(-1)?.text).toContain("MANGO");
    expect(preambleReport(session.id)?.channel).toBe("native");
    fresh.commit("p2");
    expect(
      await instructionsStaleNow(
        { id: session.id, providerSessionId: "p2" },
        project,
      ),
    ).toBe(false);
  });

  it("a reply from another conversation than the receipt names resets the start (resume lost)", async () => {
    const session = chat("claude");
    (await turn(session, undefined)).commit("p1");
    files.set("global::instructions.md", "The code word is MANGO.");
    const lost = await turn(session, "p1");
    // Claude Code started a new conversation with the current launch file.
    lost.commit("p9");
    expect(
      await instructionsStaleNow(
        { id: session.id, providerSessionId: "p9" },
        project,
      ),
    ).toBe(false);
  });

  it("Codex: a new thread gets the new developer instructions", async () => {
    const session = chat("codex");
    (await turn(session, undefined)).commit("t1");
    files.set("global::instructions.md", "The code word is MANGO.");
    const fresh = await turn(session, undefined);
    expect(fresh.developerInstructions).toContain("MANGO");
    expect(fresh.messageBlock).toBe("");
  });
});

describe("finding 2.2: a harness with no native channel", () => {
  it("gets the note on its first turn, not after a change, and again after a compaction (corner case 16)", async () => {
    const session = chat("cursor");
    const first = await turn(session, undefined, { blocks: [] });
    expect(first.messageBlock).toContain("PINEAPPLE");
    expect(first.messageBlock).toContain("These are my current instructions");
    expect(preambleSummary(preambleReport(session.id))).toMatch(
      /^Sent ahead of the message\. /,
    );
    first.commit("c1");
    files.set("global::instructions.md", "The code word is MANGO.");
    const changed = await turn(session, "c1", { blocks: [] });
    expect(changed.messageBlock).toBe("");
    expect(preambleReport(session.id)?.stale).toBe(true);
    changed.commit("c1");
    const compacted: Block[] = [
      { id: "c", role: "system", text: "Compacted context" } as Block,
    ];
    const after = await turn(session, "c1", { blocks: compacted });
    // The context is gone, so the current text goes, as "current".
    expect(after.messageBlock).toContain("MANGO");
    expect(after.messageBlock).not.toMatch(/I changed/);
    after.commit("c1");
    expect(preambleReport(session.id)?.stale).toBe(false);
  });

  it("the first prompt after a restart does not count old compactions as new (corner case 16)", async () => {
    const session = chat("cursor");
    const compacted: Block[] = [
      { id: "c", role: "system", text: "Compacted context" } as Block,
    ];
    (await turn(session, undefined, { blocks: [] })).commit("c1");
    vi.resetModules();
    const reloaded = await import("./sessionPreamble");
    const again = await reloaded.prepareSessionPreamble({
      session: { ...session, providerSessionId: "c1", blocks: compacted },
      project,
      commandFirst: false,
    });
    expect(again.messageBlock).toBe("");
  });

  it("a new provider conversation without a native channel gets the note", async () => {
    const session = chat("cursor");
    (await turn(session, undefined)).commit("c1");
    // The reply came from another conversation: it got nothing.
    (await turn(session, "c1")).commit("c2");
    const next = await turn(session, "c2");
    expect(next.messageBlock).toContain("PINEAPPLE");
  });
});

describe("finding 2.2: app parts are not instructions", () => {
  it("/operator reaches a running Claude Code chat in a neutral note (security item 5)", async () => {
    const session = chat("claude");
    (await turn(session, undefined)).commit("p1");
    files.set("global::instructions.md", "The code word is MANGO.");
    const on = await turn(session, "p1", { operatorBlock });
    expect(on.messageBlock).toContain("App access is on.");
    expect(on.messageBlock).toContain(
      "This is MonoCode's note about app access and preview servers for this chat.",
    );
    expect(on.messageBlock).not.toMatch(/I changed my instructions/);
    expect(on.messageBlock).not.toMatch(/my current instructions/);
    // No instruction content rides along.
    expect(on.messageBlock).not.toContain("MANGO");
    expect(on.messageBlock).not.toContain("PINEAPPLE");
    expect(on.messageBlock).not.toContain("npm run check");
    expect(on.messageBlock).not.toContain("United");
    expect(preambleReport(session.id)?.channel).toBe("app");
    expect(preambleSummary(preambleReport(session.id))).toMatch(
      /^Given at the start\. App access sent ahead of the message\. /,
    );
    on.commit("p1");
    const same = await turn(session, "p1", { operatorBlock });
    expect(same.messageBlock).toBe("");
  });

  it("the app note goes again after a compaction on a native harness, the instructions do not", async () => {
    const session = chat("codex");
    (await turn(session, undefined, { operatorBlock, blocks: [] })).commit(
      "t1",
    );
    const compacted: Block[] = [
      { id: "c", role: "system", text: "Compacted context" } as Block,
    ];
    const after = await turn(session, "t1", {
      operatorBlock,
      blocks: compacted,
    });
    expect(after.messageBlock).toContain("App access is on.");
    expect(after.messageBlock).not.toContain("PINEAPPLE");
  });

  it("the budget is unchanged (corner case 1)", () => {
    expect(preambleBudget(16_384)).toBe(3_276);
    expect(preambleBudget(200_000)).toBe(24_576);
  });
});

describe("finding 2.2: the stale state survives a reload and goes with the chat", () => {
  it("persists across a reload (corner case 14)", async () => {
    const session = chat("claude");
    (await turn(session, undefined)).commit("p1");
    files.set("global::instructions.md", "The code word is MANGO.");
    vi.resetModules();
    const reloaded = await import("./sessionPreamble");
    expect(
      await reloaded.instructionsStaleNow(
        { id: session.id, providerSessionId: "p1" },
        project,
      ),
    ).toBe(true);
  });

  it("a deleted chat forgets it", async () => {
    const session = chat("claude");
    (await turn(session, undefined)).commit("p1");
    files.set("global::instructions.md", "The code word is MANGO.");
    forgetSessionContext(session.id);
    expect(
      await instructionsStaleNow(
        { id: session.id, providerSessionId: "p1" },
        project,
      ),
    ).toBe(false);
  });

  it("a blank chat owns nothing (corner case 28)", async () => {
    expect(
      await instructionsStaleNow(
        { id: "blank", providerSessionId: undefined },
        project,
      ),
    ).toBe(false);
  });
});

describe("finding 2.2: the interface", () => {
  it("the stale line says it once and offers a new chat", () => {
    const html = renderToStaticMarkup(
      createElement(StaleInstructionsView, { onNewChat: () => {} }),
    );
    expect(STALE_INSTRUCTIONS_TEXT).toBe(
      "Your instructions changed after this chat started. They apply to new chats.",
    );
    expect(html).toContain(STALE_INSTRUCTIONS_TEXT);
    expect(html).toContain("data-instructions-new-chat");
    expect(html).toContain(`>${NEW_CHAT_WITH_THESE}</button>`);
    expect(html).toContain('role="status"');
    // No callback, no dead control (corner case 11).
    const bare = renderToStaticMarkup(createElement(StaleInstructionsView, {}));
    expect(bare).not.toContain("data-instructions-new-chat");
  });

  it("an accepted memory says new chats get it", () => {
    expect(acceptedNote("/Users/tony/my proj")).toBe(
      "Remembered. New chats in my proj get it.",
    );
  });

  it("Settings, Instructions says a change applies to new chats, and keeps the budget sentence", async () => {
    const { InstructionsPage, INSTRUCTIONS_APPLY_TEXT } =
      await import("../../project-context/ui/InstructionsPage");
    expect(INSTRUCTIONS_APPLY_TEXT).toBe(
      "A change applies to new chats. Open chats keep what they started with.",
    );
    const html = renderToStaticMarkup(
      createElement(InstructionsPage, { cwd: project }),
    );
    expect(html).toContain(INSTRUCTIONS_APPLY_TEXT);
    expect(html).toContain("3,276");
    expect(html).toContain("24,576");
  });
});
