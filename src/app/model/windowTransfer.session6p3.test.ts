import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mac 4.14: a Claude Code chat moved to a new window started with
// `--session-id <new id>` and no `--resume`, so it lost its conversation.
// The new window bound only chats restored after a restart to their provider
// conversations, never chats that arrived in a transfer.

const spawns = vi.hoisted(() => [] as Array<{ id: string; args: string[] }>);
const sent = vi.hoisted(() => [] as string[]);
const lines = vi.hoisted(() => new Map<string, (line: string) => void>());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));
vi.mock("../../integrations/harness/core/existingDirs", () => ({
  existingDirs: async (dirs?: readonly string[]) => [...(dirs ?? [])],
}));
vi.mock("../../integrations/harness/core/child", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../integrations/harness/core/child")
    >();
  return {
    ...actual,
    resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
    resolveCodexBinary: async () => ({ path: "/fake/codex" }),
    spawnChild: async (id: string, _command: string, args: string[]) => {
      spawns.push({ id, args });
    },
    killChild: async () => undefined,
    unwatchChild: () => undefined,
    watchChild: (id: string, line: (l: string) => void) => {
      lines.set(id, line);
    },
    writeChild: async (_id: string, line: string) => {
      sent.push(line);
    },
  };
});

import {
  newSession,
  type Session,
} from "../../features/sessions/model/session";
import { newTab } from "../../features/workspace/model/layout";
import {
  bootSessionsToBind,
  collectWindowTransfer,
  type WindowTransferPayload,
} from "./windowTransfer";
import { bindResumedSessions } from "./appLifecycle";
import { ensureClaudeRegistered } from "../../integrations/harness/providers/claude/claudeAdapter";
import { ensureCodexRegistered } from "../../integrations/harness/providers/codex/codexAdapter";
import {
  sendClaudeTurn,
  stopClaudeSession,
  __claudeTestReset,
} from "../../integrations/harness/providers/claude/claude";
import {
  sendCodexTurn,
  stopCodexSession,
  __codexTestReset,
} from "../../integrations/harness/providers/codex/codex";

const CWD = "/Users/tonyg/my proj";
const CONVERSATION = "6533353b-1111-4222-8333-444455556666";

function movedChat(harness: "claude" | "codex", providerSessionId: string) {
  const session: Session = {
    ...newSession(harness, CWD),
    harness,
    providerSessionId,
  };
  const keep = newTab(newSession("claude", CWD).id);
  const moving = newTab(session.id);
  const payload = collectWindowTransfer(
    [keep, moving],
    [session],
    [moving.id],
    moving.id,
    new Set(),
    CWD,
  )!;
  // What the new window takes: the staged JSON, parsed.
  const taken = JSON.parse(JSON.stringify(payload)) as WindowTransferPayload;
  return { session, taken };
}

beforeEach(() => {
  vi.useFakeTimers();
  spawns.length = 0;
  sent.length = 0;
  lines.clear();
  ensureClaudeRegistered();
  ensureCodexRegistered();
  __claudeTestReset();
  __codexTestReset();
});

afterEach(async () => {
  vi.useRealTimers();
});

describe("the transfer keeps what resume needs", () => {
  it("carries the chat's provider conversation, folder and harness", () => {
    const { session, taken } = movedChat("claude", CONVERSATION);
    expect(taken.sessions).toHaveLength(1);
    expect(taken.sessions[0]).toMatchObject({
      id: session.id,
      harness: "claude",
      cwd: CWD,
      providerSessionId: CONVERSATION,
    });
  });

  it("binds the moved chats at boot, as it binds restored ones", () => {
    const { taken } = movedChat("claude", CONVERSATION);
    expect(bootSessionsToBind(taken, null)).toEqual(taken.sessions);
    const restored = [newSession("claude", CWD)];
    expect(bootSessionsToBind(null, { sessions: restored })).toBe(restored);
    expect(bootSessionsToBind(null, null)).toEqual([]);
  });
});

async function firstClaudeSpawn(session: Session) {
  const done = sendClaudeTurn({
    sessionId: session.id,
    cwd: CWD,
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: "supervised",
    attachments: [],
    text: "What word did I ask you to remember?",
    onEvent: () => undefined,
  });
  await vi.advanceTimersByTimeAsync(0);
  const spawn = spawns.find((entry) => entry.id === session.id);
  // Let the turn end so nothing is left running.
  const line = lines.get(session.id);
  line?.(
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: CONVERSATION,
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  line?.(
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: CONVERSATION,
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  await done.catch(() => undefined);
  await stopClaudeSession(session.id);
  return spawn!.args;
}

describe("a moved Claude Code chat's first prompt in the new window", () => {
  it("resumes its conversation", async () => {
    const { taken } = movedChat("claude", CONVERSATION);
    bindResumedSessions(bootSessionsToBind(taken, null));
    const args = await firstClaudeSpawn(taken.sessions[0]);
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe(CONVERSATION);
    expect(args).not.toContain("--session-id");
  });

  it("started a new conversation when only restored chats were bound (the Mac bug)", async () => {
    const { taken } = movedChat("claude", CONVERSATION);
    // The old boot: `if (resumed?.sessions.length) bindResumedSessions(...)`.
    const resumed = null as { sessions: Session[] } | null;
    if (resumed?.sessions.length) bindResumedSessions(resumed.sessions);
    const args = await firstClaudeSpawn(taken.sessions[0]);
    expect(args).not.toContain("--resume");
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).not.toBe(CONVERSATION);
  });
});

describe("a moved Codex chat's first prompt in the new window", () => {
  it("asks for thread/resume with its thread id", async () => {
    vi.useRealTimers();
    const { taken } = movedChat("codex", "thr_moved");
    bindResumedSessions(bootSessionsToBind(taken, null));
    const session = taken.sessions[0];
    const turn = sendCodexTurn({
      sessionId: session.id,
      cwd: CWD,
      model: "codex:gpt-5.4",
      modelSettings: {},
      runtimeMode: "supervised",
      text: "What word did I ask you to remember?",
      attachments: [],
      onEvent: () => undefined,
    });
    const parse = () =>
      sent.map((line) => JSON.parse(line) as Record<string, unknown>);
    const waitFor = async (method: string) => {
      for (let i = 0; i < 100; i += 1) {
        const found = parse().find((message) => message.method === method);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(
        `no ${method}; sent ${parse()
          .map((m) => m.method ?? m.id)
          .join(", ")}; spawns ${JSON.stringify(spawns)}`,
      );
    };
    const init = await waitFor("initialize");
    lines.get(session.id)!(JSON.stringify({ id: init.id, result: {} }));
    const resume = await waitFor("thread/resume");
    expect(resume.params).toMatchObject({ threadId: "thr_moved" });
    expect(parse().some((message) => message.method === "thread/start")).toBe(
      false,
    );
    void turn.catch(() => undefined);
    await stopCodexSession(session.id);
  });
});
