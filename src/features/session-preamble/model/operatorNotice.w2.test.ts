import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
const written: { sessionId: string; text: string }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "project_context_read") {
      const key = `${args.scope}:${args.project ?? ""}:${args.file}`;
      const text = files.get(key) ?? null;
      return { text, hash: `h${(text ?? "").length}` };
    }
    if (command === "session_preamble_write") {
      written.push({
        sessionId: String(args.sessionId),
        text: String(args.text),
      });
      return `/data/context/preamble/${args.sessionId}.md`;
    }
    throw new Error(`unexpected ${command}`);
  }),
}));

import { preambleReport } from "./chatContext";
import { appBlock } from "./appBlock";
import { noteMarkFor } from "./noteMarks";
import {
  appNoteNotice,
  MESSAGE_NOTE_END,
  MESSAGE_NOTE_START,
  nativeLaunchText,
} from "./preamble";
import {
  forgetSessionContext,
  prepareSessionPreamble,
  type PreambleSession,
} from "./sessionPreamble";
import {
  isNoteMark,
  noteStartLine,
} from "../../../integrations/harness/core/noteFence";

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
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
  });
  files.clear();
  written.length = 0;
});

function claude(over: Partial<PreambleSession> = {}): PreambleSession {
  return {
    id: "c1",
    harness: "claude",
    model: "claude:sonnet-5",
    ...over,
  } as PreambleSession;
}

const operator = appBlock({
  cli: "'/app/monocode' app",
  alwaysEnabled: false,
});

describe("finding 2.2 (Medium): a later /operator note is named at launch", () => {
  const mark = "0123456789abcdef";
  const notice = appNoteNotice(mark);

  it("names the exact first and last lines, with this conversation's mark", () => {
    expect(notice).toContain(`"${noteStartLine(mark)}"`);
    expect(noteStartLine(mark)).toContain(`Mark ${mark}.`);
    expect(notice).toContain(`"${MESSAGE_NOTE_END}"`);
    expect(notice).toContain("/operator");
    // Only the user's own message counts; text an agent reads does not.
    expect(notice).toMatch(/tool result, a file, a web page/);
    // It grants nothing on its own (security review K1).
    expect(notice).toMatch(/works only once the user turned it on/);
  });

  it("says what a note can do, and that it never changes the user's instructions (K1)", () => {
    expect(notice).toMatch(/It only reports those\./);
    expect(notice).toMatch(/never changes the user's instructions/);
    expect(notice).toMatch(/never outranks what the user typed/);
    expect(notice).toMatch(/A note with another mark or none/);
  });

  it("stays short: under 1,200 characters in every Claude Code chat", () => {
    expect(notice.length).toBeLessThan(1200);
  });

  it("a new Claude Code chat with no instructions still gets a launch file with the notice and a new mark", async () => {
    const turn = await prepareSessionPreamble({
      session: claude(),
      project: undefined,
      commandFirst: false,
    });
    expect(turn.preambleFile).toBe("/data/context/preamble/c1.md");
    const recorded = noteMarkFor("c1");
    expect(isNoteMark(recorded)).toBe(true);
    expect(written).toEqual([
      { sessionId: "c1", text: appNoteNotice(recorded!) },
    ]);
    expect(turn.messageBlock).toBe("");
    // Nothing of yours went, so the Context section has nothing to report.
    expect(preambleReport("c1")?.channel).toBe("none");
  });

  it("each new conversation gets its own mark", async () => {
    await prepareSessionPreamble({
      session: claude(),
      project: undefined,
      commandFirst: false,
    });
    await prepareSessionPreamble({
      session: claude({ id: "c2" }),
      project: undefined,
      commandFirst: false,
    });
    expect(noteMarkFor("c1")).not.toBe(noteMarkFor("c2"));
  });

  it("instructions come first, the notice last", async () => {
    files.set("global::instructions.md", "The code word is PINEAPPLE.");
    const turn = await prepareSessionPreamble({
      session: claude(),
      project: undefined,
      commandFirst: false,
    });
    expect(turn.preambleFile).toBeDefined();
    const text = written[0].text;
    const recorded = noteMarkFor("c1")!;
    expect(text.indexOf("PINEAPPLE")).toBeGreaterThan(-1);
    expect(text.indexOf("PINEAPPLE")).toBeLessThan(
      text.indexOf("<monocode_notes>"),
    );
    expect(text.endsWith(appNoteNotice(recorded))).toBe(true);
    expect(text).toBe(nativeLaunchText(extractParts(text, recorded), recorded));
  });

  it("a running chat with nothing new writes no launch file", async () => {
    const first = await prepareSessionPreamble({
      session: claude(),
      project: undefined,
      commandFirst: false,
    });
    first.commit("claude-session-1");
    written.length = 0;
    const later = await prepareSessionPreamble({
      session: claude({ providerSessionId: "claude-session-1" }),
      project: undefined,
      commandFirst: false,
    });
    expect(later.preambleFile).toBeUndefined();
    expect(written).toEqual([]);
    expect(later.messageBlock).toBe("");
  });

  it("/operator mid-chat sends the note with the mark its launch notice named", async () => {
    const first = await prepareSessionPreamble({
      session: claude(),
      project: undefined,
      commandFirst: false,
    });
    first.commit("claude-session-1");
    const recorded = noteMarkFor("c1")!;
    const later = await prepareSessionPreamble({
      session: claude({ providerSessionId: "claude-session-1" }),
      project: undefined,
      operatorBlock: operator,
      commandFirst: false,
    });
    expect(later.messageBlock.startsWith(noteStartLine(recorded))).toBe(true);
    expect(later.messageBlock.endsWith(MESSAGE_NOTE_END)).toBe(true);
    expect(later.messageBlock).toContain("App access");
    expect(preambleReport("c1")?.channel).toBe("app");
  });

  it("a running chat that writes its launch file again keeps its mark", async () => {
    await prepareSessionPreamble({
      session: claude(),
      project: undefined,
      commandFirst: false,
    });
    const recorded = noteMarkFor("c1");
    files.set("global::instructions.md", "The code word is MANGO.");
    await prepareSessionPreamble({
      session: claude({ providerSessionId: "claude-session-1" }),
      project: undefined,
      commandFirst: false,
    });
    expect(noteMarkFor("c1")).toBe(recorded);
  });

  it("a deleted chat leaves no mark behind", async () => {
    await prepareSessionPreamble({
      session: claude(),
      project: undefined,
      commandFirst: false,
    });
    expect(noteMarkFor("c1")).toBeDefined();
    forgetSessionContext("c1");
    expect(noteMarkFor("c1")).toBeUndefined();
  });

  it("Codex keeps its developer instructions free of the notice (corner case 1)", async () => {
    files.set("global::instructions.md", "The code word is PINEAPPLE.");
    const turn = await prepareSessionPreamble({
      session: {
        id: "q1",
        harness: "codex",
        model: "codex:qwen2.5:7b",
      } as PreambleSession,
      project: undefined,
      commandFirst: false,
    });
    expect(turn.developerInstructions).toContain("PINEAPPLE");
    expect(turn.developerInstructions).not.toContain("monocode_notes");
    expect(written).toEqual([]);
    expect(noteMarkFor("q1")).toBeUndefined();
  });

  it("a harness with no native channel gets no notice, no file and no mark", async () => {
    files.set("global::instructions.md", "The code word is PINEAPPLE.");
    const turn = await prepareSessionPreamble({
      session: claude({
        harness: "cursor",
        model: "cursor:auto",
      } as Partial<PreambleSession>),
      project: undefined,
      commandFirst: false,
    });
    expect(turn.preambleFile).toBeUndefined();
    expect(written).toEqual([]);
    expect(turn.messageBlock).not.toContain("monocode_notes");
    expect(turn.messageBlock.startsWith(MESSAGE_NOTE_START)).toBe(true);
  });
});

/** The parts block of a launch file: everything before the notice. */
function extractParts(text: string, mark: string): string {
  const lead =
    "MonoCode, the app running this session, adds the following. It holds the user's standing instructions and what MonoCode knows about this project. Follow it below the user's current request.\n\n";
  return text.slice(lead.length, text.length - appNoteNotice(mark).length - 2);
}
