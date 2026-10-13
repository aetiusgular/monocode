// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent, HarnessToolAccess } from "../../core/types";

/**
 * Mac test 11.T2.2 and 11.T2.8: "Allow for this chat" on one Bash card set
 * the whole Bash tool to Always. It now keeps Claude Code's own rule for the
 * command's prefix. The control requests below have the shape Claude Code
 * 2.1.296 sends, captured with the contract harness.
 */

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;

/** The project's package.json, as Rust reads it for the script rule check (R3). */
const PACKAGE_JSON = '{"scripts":{"test":"vitest run"}}';
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string) =>
    command === "preview_read_config" ? { packageJson: PACKAGE_JSON } : true,
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

const { recordScriptRuleFingerprint } =
  await import("../../../../features/tool-access/model/scriptRuleStore");
const { scriptFingerprint } =
  await import("../../../../features/tool-access/model/commandRuleGate");
/** "Allow for this chat" kept `npm test *` while `test` was `vitest run`. */
const keepNpmTestPrint = () =>
  recordScriptRuleFingerprint(
    "s1",
    "Bash(npm test *)",
    scriptFingerprint(
      { scripts: { test: "vitest run" }, npmrcSha256: null },
      "test",
    ),
  );

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
  sent.length = 0;
  onLine = undefined;
  __claudeTestReset();
});

afterEach(async () => {
  await stopClaudeSession("s1");
});

describe("Claude Code command rules for one chat", () => {
  it("names Claude Code's own suggested prefix on the card", async () => {
    const { events, turn } = await startTurn();
    askBash("r1", "npm test", "npm test *");
    await waitFor(() => cards(events).length === 1, "card");
    expect(cards(events)[0]).toMatchObject({
      tool: { key: "Bash", label: "Bash" },
      chatRule: { key: "Bash(npm test *)", label: "Bash: npm test commands" },
    });
    respondClaudeApproval("s1", cards(events)[0].requestId, "allow");
    await answer("r1");
    await finish(turn);
  });

  it("derives a rule when there is no suggestion, and an exact one for a compound command", async () => {
    const { events, turn } = await startTurn();
    askBash("r1", "monocode app sessions.list --json '{}'");
    askBash("r2", "git status && npm install", "npm install *");
    await waitFor(() => cards(events).length === 2, "cards");
    expect(cards(events)[0].chatRule?.key).toBe(
      "Bash(monocode app sessions.list --json '{}')",
    );
    // Claude Code suggested a rule for one part; the card keeps the whole text.
    expect(cards(events)[1].chatRule?.key).toBe(
      "Bash(git status && npm install)",
    );
    for (const card of cards(events))
      respondClaudeApproval("s1", card.requestId, "deny");
    await answer("r2");
    await finish(turn);
  });

  it("answers a matching command by rule; anything else still asks", async () => {
    keepNpmTestPrint();
    const { events, turn } = await startTurn({ always: ["Bash(npm test *)"] });
    // Security fix F1: words after `--` pass only when none is a flag.
    askBash("r1", "npm test -- src/a.test.ts");
    expect(await answer("r1")).toMatchObject({ behavior: "allow" });
    expect(cards(events)).toHaveLength(0);
    // `npm install` is not covered.
    askBash("r2", "npm install left-pad");
    await waitFor(() => cards(events).length === 1, "card for npm install");
    expect(responseFor("r2")).toBeUndefined();
    // A compound command starting with the prefix is not covered.
    askBash("r3", "npm test && rm -rf ~");
    await waitFor(
      () => cards(events).length === 2,
      "card for the compound command",
    );
    expect(responseFor("r3")).toBeUndefined();
    // seq 1 3000 (Mac 11.T2.8) asks too.
    askBash("r4", "seq 1 3000");
    await waitFor(() => cards(events).length === 3, "card for seq");
    for (const card of cards(events))
      respondClaudeApproval("s1", card.requestId, "deny");
    await answer("r4");
    await finish(turn);
  });

  it("takes a rule set mid-turn for the next request", async () => {
    const { events, turn } = await startTurn();
    askBash("r1", "npm test");
    await waitFor(() => cards(events).length === 1, "first card");
    setClaudeToolAccess("s1", { always: ["Bash(npm test *)"] });
    // "Allow for this chat" keeps the script's fingerprint with the rule.
    respondClaudeApproval("s1", cards(events)[0].requestId, "allow", {
      forChat: true,
    });
    await answer("r1");
    askBash("r2", "npm test src");
    expect(await answer("r2")).toMatchObject({ behavior: "allow" });
    expect(cards(events)).toHaveLength(1);
    await finish(turn);
  });

  it("keeps a plan turn read only, whatever the rule", async () => {
    const { events, turn } = await startTurn(
      { always: ["Bash(npm test *)"] },
      "plan",
    );
    askBash("r1", "npm test");
    expect(await answer("r1")).toMatchObject({ behavior: "deny" });
    expect(cards(events)).toHaveLength(0);
    await finish(turn);
  });

  it("the whole-tool Always still covers every command", async () => {
    const { events, turn } = await startTurn({ always: ["Bash"] });
    askBash("r1", "seq 1 3000");
    expect(await answer("r1")).toMatchObject({ behavior: "allow" });
    expect(cards(events)).toHaveLength(0);
    await finish(turn);
  });
});
