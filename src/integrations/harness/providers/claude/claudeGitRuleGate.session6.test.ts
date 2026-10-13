// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent, HarnessToolAccess } from "../../core/types";

/**
 * Security fix R2: a git rule answers only when the repository's own config
 * names no command git would run. Control requests have Claude Code
 * 2.1.296's shape.
 */

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;

/** Rust's answers, by command; a function answers per call. */
const answers: Record<string, unknown> = {};
const calls: Array<[string, Record<string, unknown>]> = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    calls.push([command, args]);
    const answer = answers[command];
    if (answer instanceof Error) throw answer;
    return answer === undefined ? true : answer;
  },
}));
vi.mock("../../core/existingDirs", () => ({
  existingDirs: async (dirs?: readonly string[]) => [...(dirs ?? [])],
}));
vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async () => undefined,
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
  respondClaudeApproval,
  sendClaudeTurn,
  setClaudeToolAccess,
  stopClaudeSession,
  __claudeTestReset,
} = await import("./claude");

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

async function startTurn(toolAccess?: HarnessToolAccess, intent?: "plan") {
  const events: HarnessEvent[] = [];
  const turn = sendClaudeTurn({
    sessionId: "s1",
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: "supervised",
    intent,
    toolAccess,
    text: "run the tests",
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
  emit({ type: "system", subtype: "init", session_id: "sess_1" });
  emit({
    type: "control_response",
    response: { subtype: "success", request_id: "monocode_1" },
  });
  await waitFor(() => parse().some((m) => m.type === "user"), "user prompt");
  return { events, turn };
}

function askBash(requestId: string, command: string, suggestion?: string) {
  emit({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      display_name: "Bash",
      input: { command, description: "x" },
      description: "x",
      ...(suggestion
        ? {
            permission_suggestions: [
              {
                type: "addRules",
                rules: [{ toolName: "Bash", ruleContent: suggestion }],
                behavior: "allow",
                destination: "localSettings",
              },
            ],
          }
        : {}),
      decision_reason: "This command requires approval",
      decision_reason_type: "other",
      tool_use_id: `use_${requestId}`,
    },
  });
}

const responseFor = (requestId: string) =>
  parse().find(
    (m) => (m.response as Record<string, unknown>)?.request_id === requestId,
  );
async function answer(requestId: string) {
  await waitFor(() => !!responseFor(requestId), `answer to ${requestId}`);
  return (
    responseFor(requestId)!.response as { response: Record<string, unknown> }
  ).response;
}
const cards = (events: HarnessEvent[]) =>
  events.filter(
    (e): e is Extract<HarnessEvent, { type: "approval.requested" }> =>
      e.type === "approval.requested",
  );

async function finish(turn: Promise<void>) {
  emit({ type: "result", subtype: "success", session_id: "sess_1" });
  await turn;
}

beforeEach(() => {
  for (const key of Object.keys(answers)) delete answers[key];
  calls.length = 0;
  sent.length = 0;
  onLine = undefined;
  __claudeTestReset();
});

afterEach(async () => {
  await stopClaudeSession("s1");
});

describe("git rules and the repository's own commands (R2)", () => {
  it("a git rule answers when the repository names no command", async () => {
    answers.git_repo_names_commands = false;
    const { events, turn } = await startTurn({ always: ["Bash(git log *)"] });
    askBash("r1", "git log --oneline -5");
    expect(await answer("r1")).toMatchObject({ behavior: "allow" });
    expect(cards(events)).toHaveLength(0);
    expect(calls).toContainEqual(["git_repo_names_commands", { cwd: "/repo" }]);
    await finish(turn);
  });

  it("shows the card when the repository names a command", async () => {
    // An agent wrote `diff.external` or a `.gitattributes` textconv.
    answers.git_repo_names_commands = true;
    const { events, turn } = await startTurn({ always: ["Bash(git diff *)"] });
    askBash("r1", "git diff --stat");
    await waitFor(() => cards(events).length === 1, "card");
    expect(responseFor("r1")).toBeUndefined();
    respondClaudeApproval("s1", cards(events)[0].requestId, "deny");
    await answer("r1");
    await finish(turn);
  });

  it("shows the card when the check fails or answers oddly", async () => {
    answers.git_repo_names_commands = new Error("git not found");
    const { events, turn } = await startTurn({
      always: ["Bash(git status *)", "Bash(git status)"],
    });
    askBash("r1", "git status -s");
    await waitFor(() => cards(events).length === 1, "card on error");
    answers.git_repo_names_commands = "no";
    // An exact git rule is checked too.
    askBash("r2", "git status");
    await waitFor(() => cards(events).length === 2, "card on odd answer");
    for (const card of cards(events))
      respondClaudeApproval("s1", card.requestId, "deny");
    await answer("r2");
    await finish(turn);
  });

  it("the whole-tool Always is not checked", async () => {
    answers.git_repo_names_commands = true;
    const { events, turn } = await startTurn({ always: ["Bash"] });
    askBash("r1", "git status");
    expect(await answer("r1")).toMatchObject({ behavior: "allow" });
    expect(cards(events)).toHaveLength(0);
    expect(calls.some(([c]) => c === "git_repo_names_commands")).toBe(false);
    await finish(turn);
  });
});
