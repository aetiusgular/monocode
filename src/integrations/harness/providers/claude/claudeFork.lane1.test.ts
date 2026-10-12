import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../core/types";
import { buildClaudeSpawnArgs } from "./claudeProtocol";

const sent: string[] = [];
const spawned: string[][] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("../../core/existingDirs", () => ({
  existingDirs: async (dirs?: readonly string[]) => [...(dirs ?? [])],
}));
vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async (_id: string, _path: string, args: string[]) => {
    spawned.push(args);
  },
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
}));

const {
  sendClaudeTurn,
  stopClaudeSession,
  prepareClaudeFork_l1,
  forkClaudeSession_l1,
  __claudeForkPending_l1,
  __claudeTestReset,
  CLAUDE_FIRST_TURN,
} = await import("./claude");

function parse() {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}
function emit(rec: Record<string, unknown>) {
  onLine!(JSON.stringify(rec));
}
async function waitFor(pred: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/** Starts a turn on `threadId` and answers init with `claudeId`. */
async function startOn(threadId: string, claudeId: string) {
  const events: HarnessEvent[] = [];
  sent.length = 0;
  const turn = sendClaudeTurn({
    sessionId: threadId,
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: "supervised",
    text: "go on from here",
    attachments: [],
    onEvent: (event) => events.push(event),
  });
  await waitFor(
    () =>
      parse().some(
        (m) =>
          (m.request as Record<string, unknown> | undefined)?.subtype ===
          "initialize",
      ),
    "initialize",
  );
  emit({ type: "system", subtype: "init", session_id: claudeId });
  emit({
    type: "control_response",
    response: { subtype: "success", request_id: "monocode_1" },
  });
  await waitFor(() => parse().some((m) => m.type === "user"), "user prompt");
  emit({ type: "result", subtype: "success", session_id: claudeId });
  await turn.catch(() => undefined);
  return events;
}

beforeEach(() => {
  sent.length = 0;
  spawned.length = 0;
  onLine = undefined;
  __claudeTestReset();
});

afterEach(async () => {
  await stopClaudeSession("fork1");
  await stopClaudeSession("src");
  __claudeTestReset();
});

describe("--fork-session", () => {
  it("is added only with --resume", () => {
    expect(
      buildClaudeSpawnArgs({ resume: "sess_src", forkSession: true }),
    ).toContain("--fork-session");
    expect(buildClaudeSpawnArgs({ forkSession: true })).not.toContain(
      "--fork-session",
    );
  });
});

describe("Claude fork", () => {
  it("starts the new chat as a copy cut at the entry, never as the source", async () => {
    prepareClaudeFork_l1({
      threadId: "fork1",
      providerSessionId: "sess_src",
      cwd: "/repo",
      at: "entry-b",
    });
    const events = await startOn("fork1", "sess_new");
    const args = spawned[0];
    expect(flag(args, "--resume")).toBe("sess_src");
    expect(flag(args, "--resume-session-at")).toBe("entry-b");
    expect(args).toContain("--fork-session");
    // No --session-id: Claude names the copy, and MonoCode adopts the name.
    expect(args).not.toContain("--session-id");
    expect(
      events.filter((event) => event.type === "session.providerBound"),
    ).toContainEqual({ type: "session.providerBound", providerSessionId: "sess_new" });
  });

  it("resumes the copy, not the source, once Claude named it", async () => {
    prepareClaudeFork_l1({
      threadId: "fork1",
      providerSessionId: "sess_src",
      cwd: "/repo",
    });
    await startOn("fork1", "sess_new");
    await stopClaudeSession("fork1");
    await startOn("fork1", "sess_new");
    const second = spawned[1];
    expect(flag(second, "--resume")).toBe("sess_new");
    expect(second).not.toContain("--fork-session");
    expect(__claudeForkPending_l1("fork1")).toBeUndefined();
  });

  it("forks again if the first start never reached Claude's own id", async () => {
    prepareClaudeFork_l1({
      threadId: "fork1",
      providerSessionId: "sess_src",
      cwd: "/repo",
    });
    // Claude answers with the source id, as an exit before init would leave it.
    await startOn("fork1", "sess_src");
    await stopClaudeSession("fork1");
    await startOn("fork1", "sess_new");
    expect(spawned[1]).toContain("--fork-session");
    expect(flag(spawned[1], "--resume")).toBe("sess_src");
  });

  it("forks a whole conversation when there is no entry to cut at", async () => {
    prepareClaudeFork_l1({
      threadId: "fork1",
      providerSessionId: "sess_src",
      cwd: "/repo",
      at: CLAUDE_FIRST_TURN,
    });
    await startOn("fork1", "sess_new");
    expect(spawned[0]).not.toContain("--resume-session-at");
    expect(spawned[0]).toContain("--fork-session");
  });

  it("refuses without a source conversation or while the new chat runs", async () => {
    expect(() =>
      prepareClaudeFork_l1({ threadId: "fork1", providerSessionId: " ", cwd: "/repo" }),
    ).toThrow("no Claude conversation");
    await startOn("src", "sess_src");
    await expect(
      forkClaudeSession_l1({
        sourceSessionId: "x",
        newSessionId: "src",
        providerSessionId: "sess_src",
        cwd: "/repo",
      }),
    ).rejects.toThrow("already running");
  });
});
