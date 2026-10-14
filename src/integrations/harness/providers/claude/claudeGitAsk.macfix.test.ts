import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../core/types";
import type { RuntimeMode } from "../../../../features/sessions/model/session";

/**
 * Mac test 10.1, second point (retest 2, 13 Oct): Claude Code ran
 * `git show --stat HEAD` on its own read-only rule, with no card, in a
 * partial clone whose `remote.origin.uploadpack` was a planted script, and
 * the read ran it. MonoCode now starts Claude Code with an ask rule for git
 * in a repository whose own config names a command.
 */

const sent: string[] = [];
const spawned: string[][] = [];
let onLine: ((line: string) => void) | undefined;

/** Rust's answers, by command and folder. */
const namesCommands = new Map<string, unknown>();
const calls: Array<[string, Record<string, unknown>]> = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    calls.push([command, args]);
    if (command !== "git_repo_names_commands") return true;
    const answer = namesCommands.get(String(args.cwd));
    if (answer instanceof Error) throw answer;
    return answer;
  },
}));
vi.mock("../../core/existingDirs", () => ({
  existingDirs: async (dirs?: readonly string[]) =>
    (dirs ?? []).filter((dir) => !dir.includes("gone")),
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

const { sendClaudeTurn, stopClaudeSession, __claudeTestReset } =
  await import("./claude");
const { CLAUDE_GIT_ASK_RULE, claudeGitAskNeeded } =
  await import("./claudeGitAsk");

const parse = () =>
  sent.map((line) => JSON.parse(line) as Record<string, unknown>);
const emit = (rec: Record<string, unknown>) => onLine!(JSON.stringify(rec));
const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};
const settingsOf = (args: string[]) =>
  JSON.parse(args[args.indexOf("--settings") + 1]) as Record<string, unknown>;
const prompts = () => parse().filter((m) => m.type === "user").length;

function send(runtimeMode: RuntimeMode = "supervised", extraDirs?: string[]) {
  const events: HarnessEvent[] = [];
  const turn = sendClaudeTurn({
    sessionId: "s1",
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode,
    extraDirs,
    text: "show the last commit",
    attachments: [],
    onEvent: (event) => events.push(event),
  });
  return { events, turn };
}

/** Starts a turn on a fresh process and waits for its prompt. */
async function startTurn(runtimeMode?: RuntimeMode, extraDirs?: string[]) {
  const before = prompts();
  const spawns = spawned.length;
  const started = send(runtimeMode, extraDirs);
  await waitFor(() => spawned.length > spawns, "spawn");
  await waitFor(
    () =>
      parse().filter(
        (m) =>
          (m.request as Record<string, unknown> | undefined)?.subtype ===
          "initialize",
      ).length >= spawned.length,
    "initialize",
  );
  emit({ type: "system", subtype: "init", session_id: "sess_1" });
  emit({
    type: "control_response",
    response: { subtype: "success", request_id: `monocode_${spawned.length}` },
  });
  await waitFor(() => prompts() > before, "user prompt");
  return started;
}

async function finish(turn: Promise<void>) {
  emit({ type: "result", subtype: "success", session_id: "sess_1" });
  await turn;
}

beforeEach(() => {
  namesCommands.clear();
  calls.length = 0;
  sent.length = 0;
  spawned.length = 0;
  onLine = undefined;
  __claudeTestReset();
});

afterEach(async () => {
  await stopClaudeSession("s1");
});

describe("claudeGitAskNeeded", () => {
  const ask = (
    answers: Record<string, unknown>,
    runtimeMode: RuntimeMode = "supervised",
    extraDirs?: string[],
  ) => {
    const seen: string[] = [];
    const call = async <T>(_c: string, args: Record<string, unknown>) => {
      const dir = String(args.cwd);
      seen.push(dir);
      const answer = answers[dir];
      if (answer instanceof Error) throw answer;
      return answer as T;
    };
    return {
      result: claudeGitAskNeeded(
        { cwd: "/repo", extraDirs, runtimeMode },
        call,
      ),
      seen,
    };
  };

  it("is off when no folder names a command", async () => {
    expect(await ask({ "/repo": false }).result).toBe(false);
  });

  it("is on when the folder or an extra folder names one", async () => {
    expect(await ask({ "/repo": true }).result).toBe(true);
    expect(
      await ask({ "/repo": false, "/other": true }, "supervised", ["/other"])
        .result,
    ).toBe(true);
  });

  it("fails closed on an error or an answer that is not false", async () => {
    expect(await ask({ "/repo": new Error("git not found") }).result).toBe(
      true,
    );
    expect(await ask({ "/repo": "no" }).result).toBe(true);
    expect(await ask({}).result).toBe(true);
  });

  it("adds nothing in Full access and asks Rust nothing", async () => {
    const { result, seen } = ask({ "/repo": true }, "full-access");
    expect(await result).toBe(false);
    expect(seen).toEqual([]);
  });
});

describe("the git ask rule on Claude Code's command line", () => {
  it("is passed in --settings when the repository names a command", async () => {
    namesCommands.set("/repo", true);
    const { turn } = await startTurn();
    expect(settingsOf(spawned[0]).permissions).toEqual({
      ask: [CLAUDE_GIT_ASK_RULE],
    });
    expect(CLAUDE_GIT_ASK_RULE).toBe("Bash(git:*)");
    // Review F3: Claude Code's own start-up git calls go too.
    expect(settingsOf(spawned[0]).includeGitInstructions).toBe(false);
    expect(calls).toContainEqual(["git_repo_names_commands", { cwd: "/repo" }]);
    await finish(turn);
  });

  it("checks the extra folders the launch passes, not one that is gone", async () => {
    namesCommands.set("/repo", false);
    namesCommands.set("/docs", false);
    namesCommands.set("/gone", true);
    const { turn } = await startTurn("supervised", ["/docs", "/gone"]);
    expect(settingsOf(spawned[0])).not.toHaveProperty("permissions");
    const checked = calls
      .filter(([command]) => command === "git_repo_names_commands")
      .map(([, args]) => args.cwd);
    expect(checked).toEqual(["/repo", "/docs"]);
    await finish(turn);
  });

  it("is not passed in a repository that names nothing", async () => {
    namesCommands.set("/repo", false);
    const { turn } = await startTurn();
    expect(settingsOf(spawned[0])).not.toHaveProperty("permissions");
    expect(settingsOf(spawned[0])).not.toHaveProperty("includeGitInstructions");
    await finish(turn);
  });

  it("is passed in each mode with a card, and not in Full access", async () => {
    namesCommands.set("/repo", true);
    for (const mode of ["auto-accept-edits", "auto"] as RuntimeMode[]) {
      const { turn } = await startTurn(mode);
      expect(settingsOf(spawned.at(-1)!).permissions).toEqual({
        ask: [CLAUDE_GIT_ASK_RULE],
      });
      await finish(turn);
      await stopClaudeSession("s1");
      __claudeTestReset();
    }
    const { turn } = await startTurn("full-access");
    expect(settingsOf(spawned.at(-1)!)).not.toHaveProperty("permissions");
    await finish(turn);
  });

  it("restarts on the same conversation when the repository changes mid-chat", async () => {
    namesCommands.set("/repo", false);
    const first = await startTurn();
    expect(settingsOf(spawned[0])).not.toHaveProperty("permissions");
    await finish(first.turn);

    // The agent, or anything else, writes `remote.origin.uploadpack`.
    namesCommands.set("/repo", true);
    const second = await startTurn();
    expect(spawned).toHaveLength(2);
    expect(settingsOf(spawned[1]).permissions).toEqual({
      ask: [CLAUDE_GIT_ASK_RULE],
    });
    expect(spawned[1]).toContain("--resume");
    await finish(second.turn);
  });

  it("keeps the process while nothing changes", async () => {
    namesCommands.set("/repo", true);
    const first = await startTurn();
    await finish(first.turn);
    const before = prompts();
    const second = send();
    await waitFor(() => prompts() > before, "second prompt");
    expect(spawned).toHaveLength(1);
    await finish(second.turn);
  });
});
