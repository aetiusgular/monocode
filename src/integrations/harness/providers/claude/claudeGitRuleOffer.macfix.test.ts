// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent, HarnessToolAccess } from "../../core/types";
import { applyHarnessEvent } from "../../core/apply";
import { newSession } from "../../../../features/sessions/model/session";
import { allowForChatPlan } from "../../../../features/tool-access/ui/AllowForChatButton";

/**
 * Mac test 10.1 (15 Oct): in a repository whose own config names a command,
 * every git command shows MonoCode's card, and the card offered "Allow git
 * show in this chat". A kept git rule never answers there (R2), so pressing
 * it changed nothing and the card showed again. The card now offers no git
 * rule there. Control requests have Claude Code 2.1.296's shape.
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

/** What the card's "Allow for this chat" button would keep, if it shows. */
function offeredRule(events: HarnessEvent[], index: number) {
  const session = events.reduce(
    applyHarnessEvent,
    newSession("claude", "/repo"),
  );
  const approvals = session.blocks.flatMap((block) =>
    block.approval ? [block.approval] : [],
  );
  const plan = allowForChatPlan(approvals[index]);
  return plan ? (plan.keep?.key ?? null) : null;
}

/** Calls to the repository check made after the launch's own. */
const checksSince = (start: number) =>
  calls.slice(start).filter(([c]) => c === "git_repo_names_commands").length;

describe("the card offers a git rule only where it would answer", () => {
  it("a plain repository still offers the git rule", async () => {
    answers.git_repo_names_commands = false;
    const { events, turn } = await startTurn();
    askBash("r1", "git show HEAD");
    await waitFor(() => cards(events).length === 1, "card");
    expect(cards(events)[0].chatRule?.key).toBe("Bash(git show *)");
    expect(offeredRule(events, 0)).toBe("Bash(git show *)");
    respondClaudeApproval("s1", cards(events)[0].requestId, "deny");
    await answer("r1");
    await finish(turn);
  });

  it("a repository whose config names a command offers Allow and Deny only", async () => {
    // A partial clone with a planted `uploadpack`, as on the Mac.
    answers.git_repo_names_commands = true;
    const { events, turn } = await startTurn();
    askBash("r1", "git show HEAD");
    await waitFor(() => cards(events).length === 1, "card");
    expect(cards(events)[0].tool).toEqual({ key: "Bash", label: "Bash" });
    expect(cards(events)[0].chatRule).toBeUndefined();
    expect(offeredRule(events, 0)).toBeNull();
    // Allow still answers this one request.
    respondClaudeApproval("s1", cards(events)[0].requestId, "allow");
    expect(await answer("r1")).toMatchObject({ behavior: "allow" });
    await finish(turn);
  });

  it("a kept git rule the gate refuses is not offered again", async () => {
    answers.git_repo_names_commands = true;
    const { events, turn } = await startTurn({ always: ["Bash(git show *)"] });
    askBash("r1", "git show HEAD", "git show *");
    await waitFor(() => cards(events).length === 1, "card");
    expect(cards(events)[0].chatRule).toBeUndefined();
    expect(offeredRule(events, 0)).toBeNull();
    respondClaudeApproval("s1", cards(events)[0].requestId, "deny");
    await answer("r1");
    await finish(turn);
  });

  it("a check that fails offers no git rule, as the gate refuses one", async () => {
    answers.git_repo_names_commands = new Error("git not found");
    const { events, turn } = await startTurn();
    askBash("r1", "git log --oneline -5");
    // An exact rule whose text names git is held the same way.
    askBash("r2", "cd sub && git status");
    await waitFor(() => cards(events).length === 2, "cards");
    expect(cards(events).map((card) => card.chatRule)).toEqual([
      undefined,
      undefined,
    ]);
    for (const card of cards(events))
      respondClaudeApproval("s1", card.requestId, "deny");
    await answer("r2");
    await finish(turn);
  });

  it("other commands still offer their rules there, with no check", async () => {
    answers.git_repo_names_commands = true;
    const { events, turn } = await startTurn();
    const atStart = calls.length;
    askBash("r1", "python3 -m pytest -q");
    askBash("r2", "ls -la");
    await waitFor(() => cards(events).length === 2, "cards");
    expect(cards(events).map((card) => card.chatRule?.key)).toEqual([
      "Bash(python3 -m pytest *)",
      "Bash(ls -la)",
    ]);
    expect(offeredRule(events, 0)).toBe("Bash(python3 -m pytest *)");
    expect(offeredRule(events, 1)).toBe("Bash(ls -la)");
    expect(checksSince(atStart)).toBe(0);
    for (const card of cards(events))
      respondClaudeApproval("s1", card.requestId, "deny");
    await answer("r2");
    await finish(turn);
  });
});
