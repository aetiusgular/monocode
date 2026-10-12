import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyHarnessEvent } from "../../core/apply";
import {
  newSession,
  type RuntimeMode,
  type TurnIntent,
} from "../../../../features/sessions/model/session";
import type { HarnessEvent, HarnessToolAccess } from "../../core/types";

const sent: string[] = [];
const spawned: string[][] = [];
let onLine: ((line: string) => void) | undefined;
const writeChild = vi.fn(async (_id: string, line: string) => {
  sent.push(line);
});

// The disk half of the chat-folder check (lane 5): every path counts as inside.
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => true }));
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
  writeChild,
}));

const {
  respondClaudeApproval,
  sendClaudeTurn,
  setClaudeToolAccess,
  stopClaudeSession,
  __claudeTestReset,
} = await import("./claude");
const {
  buildClaudeSpawnArgs,
  claudeBlockedToolMessage,
  claudeSettingsKey,
  claudeSkillDenyRules,
  claudeToolDenyRules,
} = await import("./claudeProtocol");

function parse() {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function emit(rec: Record<string, unknown>) {
  onLine!(JSON.stringify(rec));
}

const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `timed out waiting for ${label}; sent=${JSON.stringify(parse())}`,
  );
};

type TurnOptions = {
  runtimeMode?: RuntimeMode;
  intent?: TurnIntent;
  toolAccess?: HarnessToolAccess;
  disabledSkills?: string[];
  disabledPlugins?: string[];
};

function send(options: TurnOptions, events: HarnessEvent[] = []) {
  return sendClaudeTurn({
    sessionId: "s1",
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: options.runtimeMode ?? "supervised",
    intent: options.intent,
    toolAccess: options.toolAccess,
    disabledSkills: options.disabledSkills,
    disabledPlugins: options.disabledPlugins,
    text: "do the work",
    attachments: [],
    onEvent: (event) => events.push(event),
  });
}

async function startTurn(options: TurnOptions = {}) {
  const events: HarnessEvent[] = [];
  const turn = send(options, events);
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

function ask(requestId: string, toolName: string, input: object = {}) {
  emit({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: toolName,
      tool_use_id: `use_${requestId}`,
      input,
    },
  });
}

/** What was written back for one permission request, once it was. */
async function answer(requestId: string) {
  const find = () =>
    parse().find(
      (m) => (m.response as Record<string, unknown>)?.request_id === requestId,
    );
  await waitFor(() => !!find(), `answer to ${requestId}`);
  return (find()!.response as { response: Record<string, unknown> }).response;
}

const answered = (requestId: string) =>
  parse().some(
    (m) => (m.response as Record<string, unknown>)?.request_id === requestId,
  );

const cards = (events: HarnessEvent[]) =>
  events.filter((event) => event.type === "approval.requested");

async function finish(turn: Promise<void>) {
  emit({ type: "result", subtype: "success", session_id: "sess_1" });
  await turn;
}

beforeEach(() => {
  sent.length = 0;
  spawned.length = 0;
  onLine = undefined;
  writeChild.mockClear();
  __claudeTestReset();
});

afterEach(async () => {
  await stopClaudeSession("s1");
  __claudeTestReset();
});

describe("Claude Code launch arguments with blocked tools", () => {
  it("passes only plain tool names as deny rules", () => {
    expect(
      claudeToolDenyRules([
        "WebFetch",
        "Bash",
        "mcp__exa__web_search",
        "Bash(rm *)",
        "--dangerously-skip-permissions",
        "codex:command",
        "",
        "Bash",
      ]),
    ).toEqual(["Bash", "WebFetch", "mcp__exa__web_search"]);
    expect(claudeToolDenyRules()).toEqual([]);
  });

  it("adds them to the one --disallowedTools list, with the connectors", () => {
    const args = buildClaudeSpawnArgs({
      disallowedTools: claudeToolDenyRules(["WebFetch", "Bash"]),
      disabledMcpServers: ["github"],
      sessionId: "id",
    });
    expect(args.filter((arg) => arg === "--disallowedTools")).toHaveLength(1);
    const flag = args.indexOf("--disallowedTools");
    expect(args.slice(flag + 1, flag + 4)).toEqual([
      "Bash",
      "WebFetch",
      "mcp__github",
    ]);
    expect(args[flag + 4]).toBe("--session-id");
    expect(args).not.toContain("--allowedTools");
  });

  it("makes the blocked tools part of the settings key", () => {
    const base = { model: "sonnet", runtimeMode: "supervised" as const };
    const none = claudeSettingsKey(base);
    const one = claudeSettingsKey({ ...base, deniedTools: ["Bash"] });
    expect(one).not.toBe(none);
    expect(
      claudeSettingsKey({ ...base, deniedTools: ["Bash", "WebFetch"] }),
    ).not.toBe(one);
    // Order does not matter, and neither does a name that is never passed.
    expect(
      claudeSettingsKey({ ...base, deniedTools: ["WebFetch", "Bash"] }),
    ).toBe(claudeSettingsKey({ ...base, deniedTools: ["Bash", "WebFetch"] }));
    expect(claudeSettingsKey({ ...base, deniedTools: [] })).toBe(none);
    expect(claudeSettingsKey({ ...base, deniedTools: ["Bash(rm *)"] })).toBe(
      none,
    );
  });
});

describe("Claude Code launch arguments with skills switched off", () => {
  it("denies each skill with and without arguments, in the documented syntax", () => {
    expect(claudeSkillDenyRules(["review-pr", "deploy", "deploy"])).toEqual([
      "Skill(deploy)",
      "Skill(deploy *)",
      "Skill(review-pr)",
      "Skill(review-pr *)",
    ]);
  });

  it("passes nothing but plain skill names into a rule", () => {
    expect(
      claudeSkillDenyRules([
        "deploy) Bash(rm *",
        "*",
        "Deploy",
        "",
        "a b",
        "--flag",
        "x".repeat(65),
      ]),
    ).toEqual([]);
    expect(claudeSkillDenyRules()).toEqual([]);
  });

  it("makes the switched-off skills part of the settings key", () => {
    const base = { model: "sonnet", runtimeMode: "supervised" as const };
    const none = claudeSettingsKey(base);
    const one = claudeSettingsKey({ ...base, disabledSkills: ["deploy"] });
    expect(one).not.toBe(none);
    expect(
      claudeSettingsKey({ ...base, disabledSkills: ["deploy", "review-pr"] }),
    ).not.toBe(one);
    expect(
      claudeSettingsKey({ ...base, disabledSkills: ["review-pr", "deploy"] }),
    ).toBe(
      claudeSettingsKey({ ...base, disabledSkills: ["deploy", "review-pr"] }),
    );
    expect(claudeSettingsKey({ ...base, disabledSkills: [] })).toBe(none);
    // Not the same key as a tool of that name being blocked.
    expect(one).not.toBe(
      claudeSettingsKey({ ...base, deniedTools: ["deploy"] }),
    );
  });

  it("starts the process with the deny rules, beside blocked tools and connectors", async () => {
    const { turn } = await startTurn({
      toolAccess: { never: ["WebFetch"] },
      disabledSkills: ["deploy"],
    });
    const flag = spawned[0].indexOf("--disallowedTools");
    expect(spawned[0].slice(flag, flag + 4)).toEqual([
      "--disallowedTools",
      "WebFetch",
      "Skill(deploy)",
      "Skill(deploy *)",
    ]);
    // The list is variadic: a flag follows it, never a positional argument.
    expect(spawned[0][flag + 4]).toBe("--session-id");
    await finish(turn);
  });

  it("restarts the process, resuming, when a skill is switched off or back on", async () => {
    const first = await startTurn();
    expect(spawned[0]).not.toContain("--disallowedTools");
    await finish(first.turn);

    const second = send({ disabledSkills: ["deploy"] });
    await waitFor(() => spawned.length === 2, "replacement process");
    expect(spawned[1]).toEqual(
      expect.arrayContaining(["Skill(deploy)", "Skill(deploy *)"]),
    );
    expect(spawned[1]).toEqual(expect.arrayContaining(["--resume", "sess_1"]));
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await waitFor(
      () => parse().filter((m) => m.type === "user").length === 2,
      "second prompt",
    );
    await finish(second);

    // The same switches again: the process is kept.
    const third = send({ disabledSkills: ["deploy"] });
    await waitFor(
      () => parse().filter((m) => m.type === "user").length === 3,
      "third prompt",
    );
    expect(spawned).toHaveLength(2);
    await finish(third);

    const fourth = send({});
    await waitFor(() => spawned.length === 3, "second replacement");
    expect(spawned[2]).not.toContain("--disallowedTools");
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await waitFor(
      () => parse().filter((m) => m.type === "user").length === 4,
      "fourth prompt",
    );
    await finish(fourth);
  });
});

describe("Claude Code launch settings with plugins switched off", () => {
  const settingsOf = (args: string[]) =>
    JSON.parse(args[args.indexOf("--settings") + 1]) as Record<string, unknown>;

  it("passes each plugin as false under enabledPlugins in --settings", async () => {
    const { turn } = await startTurn({
      disabledPlugins: ["paper-desktop@paper", "obsidian@obsidian-skills"],
    });
    const settings = settingsOf(spawned[0]);
    expect(settings.enabledPlugins).toEqual({
      "obsidian@obsidian-skills": false,
      "paper-desktop@paper": false,
    });
    // Beside the environment every session gets, in the one flag.
    expect(settings.env).toEqual({ CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" });
    expect(spawned[0].filter((arg) => arg === "--settings")).toHaveLength(1);
    await finish(turn);
  });

  it("passes no enabledPlugins key while none is off", async () => {
    const { turn } = await startTurn();
    expect(settingsOf(spawned[0])).not.toHaveProperty("enabledPlugins");
    await finish(turn);
  });

  it("makes the switched-off plugins part of the settings key", () => {
    const base = { model: "sonnet", runtimeMode: "supervised" as const };
    const none = claudeSettingsKey(base);
    const one = claudeSettingsKey({ ...base, disabledPlugins: ["a@m"] });
    expect(one).not.toBe(none);
    expect(
      claudeSettingsKey({ ...base, disabledPlugins: ["b@m", "a@m"] }),
    ).toBe(claudeSettingsKey({ ...base, disabledPlugins: ["a@m", "b@m"] }));
    expect(claudeSettingsKey({ ...base, disabledPlugins: [] })).toBe(none);
    expect(claudeSettingsKey({ ...base, disabledPlugins: ["not an id"] })).toBe(
      none,
    );
  });

  it("restarts the process, resuming, when a plugin is switched off or back on", async () => {
    const first = await startTurn();
    await finish(first.turn);

    const second = send({ disabledPlugins: ["paper-desktop@paper"] });
    await waitFor(() => spawned.length === 2, "replacement process");
    expect(settingsOf(spawned[1]).enabledPlugins).toEqual({
      "paper-desktop@paper": false,
    });
    expect(spawned[1]).toEqual(expect.arrayContaining(["--resume", "sess_1"]));
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await waitFor(
      () => parse().filter((m) => m.type === "user").length === 2,
      "second prompt",
    );
    await finish(second);

    // The same switches again: the process is kept.
    const third = send({ disabledPlugins: ["paper-desktop@paper"] });
    await waitFor(
      () => parse().filter((m) => m.type === "user").length === 3,
      "third prompt",
    );
    expect(spawned).toHaveLength(2);
    await finish(third);

    const fourth = send({});
    await waitFor(() => spawned.length === 3, "second replacement");
    expect(settingsOf(spawned[2])).not.toHaveProperty("enabledPlugins");
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await waitFor(
      () => parse().filter((m) => m.type === "user").length === 4,
      "fourth prompt",
    );
    await finish(fourth);
  });
});

describe("Claude Code per-chat tool rules", () => {
  it("starts the process without a blocked tool and never passes an allow rule", async () => {
    const { turn } = await startTurn({
      toolAccess: { always: ["Bash"], never: ["WebFetch"] },
    });
    const flag = spawned[0].indexOf("--disallowedTools");
    expect(spawned[0].slice(flag, flag + 2)).toEqual([
      "--disallowedTools",
      "WebFetch",
    ]);
    expect(spawned[0]).not.toContain("--allowedTools");
    await finish(turn);
  });

  it("allows an always-allowed tool without a card", async () => {
    const { events, turn } = await startTurn({
      toolAccess: { always: ["Bash"] },
    });
    ask("r1", "Bash", { command: "npm test" });
    expect(await answer("r1")).toEqual({
      behavior: "allow",
      updatedInput: { command: "npm test" },
    });
    expect(cards(events)).toHaveLength(0);
    // Another tool is still put to the user.
    ask("r2", "Write", { file_path: "/repo/a.txt", content: "x" });
    await waitFor(() => cards(events).length === 1, "card for Write");
    expect(answered("r2")).toBe(false);
    expect(cards(events)[0]).toMatchObject({
      tool: { key: "Write", label: "Write" },
    });
    respondClaudeApproval("s1", cards(events)[0].requestId, "deny");
    expect(await answer("r2")).toEqual({
      behavior: "deny",
      message: "User declined tool execution.",
    });
    await finish(turn);
  });

  it("refuses a blocked tool without a card and says why", async () => {
    const { events, turn } = await startTurn({
      toolAccess: { never: ["mcp__exa__web_search"] },
    });
    ask("r1", "mcp__exa__web_search", { query: "x" });
    const reply = await answer("r1");
    expect(reply).toEqual({
      behavior: "deny",
      message: claudeBlockedToolMessage("mcp__exa__web_search"),
    });
    expect(reply.message).toContain("blocked the mcp__exa__web_search tool");
    expect(reply.message).toContain("Do not call it again");
    expect(cards(events)).toHaveLength(0);
    await finish(turn);
  });

  it("refuses a blocked tool in full access and in a plan turn", async () => {
    const full = await startTurn({
      runtimeMode: "full-access",
      toolAccess: { never: ["WebSearch"] },
    });
    ask("r1", "WebSearch", { query: "x" });
    expect((await answer("r1")).behavior).toBe("deny");
    await finish(full.turn);

    // A plan turn would let a search through; the block still wins.
    const plan = send({ intent: "plan", toolAccess: { never: ["WebSearch"] } });
    await waitFor(() => spawned.length === 2, "plan process");
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await waitFor(
      () => parse().filter((m) => m.type === "user").length === 2,
      "plan prompt",
    );
    ask("r2", "WebSearch", { query: "x" });
    expect(await answer("r2")).toEqual({
      behavior: "deny",
      message: claudeBlockedToolMessage("WebSearch"),
    });
    await finish(plan);
  });

  it("keeps a plan turn read-only whatever is always allowed", async () => {
    const { events, turn } = await startTurn({
      intent: "plan",
      toolAccess: { always: ["Bash", "Write", "Read"] },
    });
    ask("r1", "Bash", { command: "rm -rf build" });
    expect((await answer("r1")).behavior).toBe("deny");
    ask("r2", "Write", { file_path: "/repo/a.txt", content: "x" });
    expect((await answer("r2")).behavior).toBe("deny");
    ask("r3", "Read", { file_path: "/repo/a.txt" });
    expect((await answer("r3")).behavior).toBe("allow");
    expect(cards(events)).toHaveLength(0);
    await finish(turn);
  });

  it("does not let a rule answer a question or a plan", async () => {
    const { events, turn } = await startTurn({
      toolAccess: { always: ["AskUserQuestion", "ExitPlanMode"] },
    });
    ask("r1", "AskUserQuestion", {
      questions: [{ question: "Which?", options: [{ label: "A" }] }],
    });
    await waitFor(
      () => events.some((event) => event.type === "question.asked"),
      "question",
    );
    expect(answered("r1")).toBe(false);
    ask("r2", "ExitPlanMode", { plan: "1. Do it" });
    expect((await answer("r2")).behavior).toBe("deny");
    expect(events).toContainEqual({ type: "plan", text: "1. Do it" });
    await stopClaudeSession("s1");
    await turn.catch(() => undefined);
  });

  it("applies a rule set in the middle of a turn to the next request", async () => {
    const { events, turn } = await startTurn();
    ask("r1", "Bash", { command: "ls" });
    await waitFor(() => cards(events).length === 1, "first card");
    respondClaudeApproval("s1", cards(events)[0].requestId, "allow");
    expect((await answer("r1")).behavior).toBe("allow");

    setClaudeToolAccess("s1", { always: ["Bash"] });
    ask("r2", "Bash", { command: "pwd" });
    expect((await answer("r2")).behavior).toBe("allow");
    expect(cards(events)).toHaveLength(1);

    setClaudeToolAccess("s1", { never: ["Bash"] });
    ask("r3", "Bash", { command: "whoami" });
    expect(await answer("r3")).toEqual({
      behavior: "deny",
      message: claudeBlockedToolMessage("Bash"),
    });
    expect(cards(events)).toHaveLength(1);

    // Cleared again: back to asking.
    setClaudeToolAccess("s1", undefined);
    ask("r4", "Bash", { command: "date" });
    await waitFor(() => cards(events).length === 2, "card after the reset");
    expect(answered("r4")).toBe(false);
    respondClaudeApproval("s1", cards(events)[1].requestId, "allow");
    await answer("r4");
    await finish(turn);
  });

  it("declines the cards on screen for a tool that gets blocked", async () => {
    const { events, turn } = await startTurn();
    ask("r1", "Bash", { command: "ls" });
    ask("r2", "Write", { file_path: "/repo/a.txt", content: "x" });
    await waitFor(() => cards(events).length === 2, "both cards");

    setClaudeToolAccess("s1", { never: ["Bash"] });
    expect(await answer("r1")).toEqual({
      behavior: "deny",
      message: claudeBlockedToolMessage("Bash"),
    });
    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    const decided = session.blocks.flatMap((block) =>
      block.approval ? [block.approval] : [],
    );
    expect(decided).toEqual([
      {
        requestId: cards(events)[0].requestId,
        decided: "deny",
        tool: { key: "Bash", label: "Bash" },
      },
      {
        requestId: cards(events)[1].requestId,
        tool: { key: "Write", label: "Write" },
      },
    ]);
    // The card for the other tool is still the user's to answer.
    expect(answered("r2")).toBe(false);
    // Answering the declined card again, as the card's menu does, is harmless.
    respondClaudeApproval("s1", cards(events)[0].requestId, "deny");
    respondClaudeApproval("s1", cards(events)[1].requestId, "allow");
    expect((await answer("r2")).behavior).toBe("allow");
    await finish(turn);
  });

  it("leaves a card on screen alone when its tool becomes always allowed", async () => {
    const { events, turn } = await startTurn();
    ask("r1", "Bash", { command: "rm -rf build" });
    await waitFor(() => cards(events).length === 1, "card");
    setClaudeToolAccess("s1", { always: ["Bash"] });
    await new Promise((r) => setTimeout(r, 20));
    expect(answered("r1")).toBe(false);
    respondClaudeApproval("s1", cards(events)[0].requestId, "deny");
    expect((await answer("r1")).behavior).toBe("deny");
    await finish(turn);
  });

  it("takes the rules of the next turn's input, with no restart for always", async () => {
    const first = await startTurn({ toolAccess: { always: ["Bash"] } });
    await finish(first.turn);

    const events: HarnessEvent[] = [];
    const second = send({ toolAccess: { always: ["Write"] } }, events);
    await waitFor(
      () => parse().filter((m) => m.type === "user").length === 2,
      "second prompt",
    );
    // Same process: an always rule is not a launch setting.
    expect(spawned).toHaveLength(1);
    ask("r1", "Write", { file_path: "/repo/a.txt", content: "x" });
    expect((await answer("r1")).behavior).toBe("allow");
    ask("r2", "Bash", { command: "ls" });
    await waitFor(() => cards(events).length === 1, "card for Bash");
    respondClaudeApproval("s1", cards(events)[0].requestId, "deny");
    await answer("r2");
    await finish(second);
  });

  it("restarts the process, resuming, when a tool is blocked between turns", async () => {
    const first = await startTurn();
    expect(spawned[0]).not.toContain("--disallowedTools");
    await finish(first.turn);

    const second = send({ toolAccess: { never: ["Bash"] } });
    await waitFor(() => spawned.length === 2, "replacement process");
    const flag = spawned[1].indexOf("--disallowedTools");
    expect(spawned[1].slice(flag, flag + 2)).toEqual([
      "--disallowedTools",
      "Bash",
    ]);
    expect(spawned[1]).toEqual(expect.arrayContaining(["--resume", "sess_1"]));
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await waitFor(
      () => parse().filter((m) => m.type === "user").length === 2,
      "second prompt",
    );
    await finish(second);
  });

  it("ignores a rule change for a session with no live process", () => {
    expect(() =>
      setClaudeToolAccess("gone", { never: ["Bash"] }),
    ).not.toThrow();
  });
});
