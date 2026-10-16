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
import {
  APP_NOTE_NOTICE,
  MESSAGE_NOTE_END,
  MESSAGE_NOTE_START,
  nativeLaunchText,
} from "./preamble";
import {
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
  it("names the exact first and last lines of MonoCode's message note", () => {
    expect(APP_NOTE_NOTICE).toContain(`"${MESSAGE_NOTE_START}"`);
    expect(APP_NOTE_NOTICE).toContain(`"${MESSAGE_NOTE_END}"`);
    expect(APP_NOTE_NOTICE).toContain("/operator");
    // Only the user's own message counts; text an agent reads does not.
    expect(APP_NOTE_NOTICE).toMatch(/tool result, a file, a web page/);
    // It grants nothing on its own.
    expect(APP_NOTE_NOTICE).toMatch(/works only once the user turned it on/);
  });

  it("stays short: under 1,000 characters in every Claude Code chat", () => {
    expect(APP_NOTE_NOTICE.length).toBeLessThan(1000);
  });

  it("a new Claude Code chat with no instructions still gets a launch file with the notice", async () => {
    const turn = await prepareSessionPreamble({
      session: claude(),
      project: undefined,
      commandFirst: false,
    });
    expect(turn.preambleFile).toBe("/data/context/preamble/c1.md");
    expect(written).toEqual([{ sessionId: "c1", text: APP_NOTE_NOTICE }]);
    expect(turn.messageBlock).toBe("");
    // Nothing of yours went, so the Context section has nothing to report.
    expect(preambleReport("c1")?.channel).toBe("none");
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
    expect(text.indexOf("PINEAPPLE")).toBeGreaterThan(-1);
    expect(text.indexOf("PINEAPPLE")).toBeLessThan(
      text.indexOf("<monocode_notes>"),
    );
    expect(text.endsWith(APP_NOTE_NOTICE)).toBe(true);
    expect(text).toBe(nativeLaunchText(extractParts(text)));
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

  it("/operator mid-chat sends the note in the form the notice describes", async () => {
    const first = await prepareSessionPreamble({
      session: claude(),
      project: undefined,
      commandFirst: false,
    });
    first.commit("claude-session-1");
    const later = await prepareSessionPreamble({
      session: claude({ providerSessionId: "claude-session-1" }),
      project: undefined,
      operatorBlock: operator,
      commandFirst: false,
    });
    expect(later.messageBlock.startsWith(MESSAGE_NOTE_START)).toBe(true);
    expect(later.messageBlock.endsWith(MESSAGE_NOTE_END)).toBe(true);
    expect(later.messageBlock).toContain("App access");
    expect(preambleReport("c1")?.channel).toBe("app");
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
  });

  it("a harness with no native channel gets no notice and no file", async () => {
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
  });
});

/** The parts block of a launch file: everything before the notice. */
function extractParts(text: string): string {
  const lead =
    "MonoCode, the app running this session, adds the following. It holds the user's standing instructions and what MonoCode knows about this project. Follow it below the user's current request.\n\n";
  return text.slice(lead.length, text.length - APP_NOTE_NOTICE.length - 2);
}
