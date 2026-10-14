// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RuntimeMode,
  TurnIntent,
} from "../../../../features/sessions/model/session";
import type { HarnessEvent, HarnessToolAccess } from "../../core/types";

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;
/** The Rust disk check: anything under a folder named `link-out` resolves outside. */
const disk = vi.fn(
  async (_cmd: string, args: { roots: string[]; paths: string[] }) =>
    args.paths.every((p) => !p.includes("/link-out/")),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: { roots: string[]; paths: string[] }) =>
    disk(cmd, args),
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

async function startTurn(
  options: {
    runtimeMode?: RuntimeMode;
    intent?: TurnIntent;
    toolAccess?: HarnessToolAccess;
    extraDirs?: string[];
  } = {},
) {
  const events: HarnessEvent[] = [];
  const turn = sendClaudeTurn({
    sessionId: "s1",
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: options.runtimeMode ?? "supervised",
    intent: options.intent,
    toolAccess: options.toolAccess,
    extraDirs: options.extraDirs,
    text: "do the work",
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
  events.filter(
    (e): e is Extract<HarnessEvent, { type: "approval.requested" }> =>
      e.type === "approval.requested",
  );

async function finish(turn: Promise<void>) {
  emit({ type: "result", subtype: "success", session_id: "sess_1" });
  await turn;
}

beforeEach(() => {
  sent.length = 0;
  onLine = undefined;
  disk.mockClear();
  __claudeTestReset();
});

afterEach(async () => {
  await stopClaudeSession("s1");
  __claudeTestReset();
});

describe("Claude Code always rule for file tools, held to the chat's folders", () => {
  it("allows Write, Edit, MultiEdit and NotebookEdit inside the folders", async () => {
    const { events, turn } = await startTurn({
      toolAccess: { always: ["Write", "Edit", "MultiEdit", "NotebookEdit"] },
      extraDirs: ["/docs"],
    });
    ask("r1", "Write", { file_path: "/repo/a.txt", content: "x" });
    ask("r2", "Edit", {
      file_path: "/docs/b.md",
      old_string: "a",
      new_string: "b",
    });
    ask("r3", "MultiEdit", { file_path: "/repo/-dash name.ts", edits: [] });
    ask("r4", "NotebookEdit", { notebook_path: "/repo/n.ipynb" });
    for (const id of ["r1", "r2", "r3", "r4"])
      expect((await answer(id)).behavior).toBe("allow");
    expect(cards(events)).toHaveLength(0);
    await finish(turn);
  });

  it("shows the card for a file outside, through .., through a symlink, or unnamed", async () => {
    const { events, turn } = await startTurn({
      toolAccess: { always: ["Write", "Edit"] },
    });
    ask("r1", "Write", { file_path: "/Users/me/.zshrc", content: "x" });
    ask("r2", "Edit", { file_path: "/repo/../etc/hosts" });
    ask("r3", "Write", { file_path: "/repo/link-out/x", content: "x" });
    ask("r4", "Write", { content: "x" });
    await waitFor(() => cards(events).length === 4, "four cards");
    expect(["r1", "r2", "r3", "r4"].some(answered)).toBe(false);
    for (const card of cards(events))
      respondClaudeApproval("s1", card.requestId, "deny");
    await answer("r4");
    await finish(turn);
  });

  it("leaves the always rule for other tools as it was", async () => {
    const { events, turn } = await startTurn({
      toolAccess: { always: ["Bash"] },
    });
    ask("r1", "Bash", { command: "ls /" });
    expect((await answer("r1")).behavior).toBe("allow");
    expect(cards(events)).toHaveLength(0);
    // The launch's git check (Mac test 10.1) is the only Rust call; the
    // folder check never runs for this rule.
    expect(
      disk.mock.calls.filter(([cmd]) => cmd !== "git_repo_names_commands"),
    ).toEqual([]);
    await finish(turn);
  });

  it("keeps Full access as the mode decides, rule or not", async () => {
    const { events, turn } = await startTurn({
      runtimeMode: "full-access",
      toolAccess: { always: ["Write"] },
    });
    ask("r1", "Write", { file_path: "/tmp/out.txt", content: "x" });
    expect((await answer("r1")).behavior).toBe("allow");
    expect(cards(events)).toHaveLength(0);
    await finish(turn);
  });

  it("keeps a plan turn read only", async () => {
    const { turn } = await startTurn({
      intent: "plan",
      toolAccess: { always: ["Write"] },
    });
    ask("r1", "Write", { file_path: "/repo/a.txt", content: "x" });
    expect((await answer("r1")).behavior).toBe("deny");
    await finish(turn);
  });
});

describe("browser tools: site approval on Claude Code", () => {
  const NAV = "mcp__playwright__browser_navigate";
  const store = (value: object) =>
    localStorage.setItem("monocode.browserSiteRules", JSON.stringify(value));
  beforeEach(() => localStorage.clear());

  it("asks with the host on the card, even when the tool is always allowed", async () => {
    const { events, turn } = await startTurn({ toolAccess: { always: [NAV] } });
    ask("r1", NAV, { url: "https://news.example/today" });
    await waitFor(() => cards(events).length === 1, "site card");
    expect(cards(events)[0].site).toEqual({
      server: "playwright",
      host: "news.example",
      hosts: ["news.example"],
      ruleable: true,
      chatKey: "s1",
      projectKey: "/repo",
    });
    respondClaudeApproval("s1", cards(events)[0].requestId, "allow");
    expect((await answer("r1")).behavior).toBe("allow");
    await finish(turn);
  });

  it("follows a chat or project rule without a card", async () => {
    store({
      chat: { s1: { "a.example": "always", "b.example": "never" } },
      project: { "/repo": { "c.example": "always" } },
    });
    const { events, turn } = await startTurn();
    ask("r1", NAV, { url: "https://a.example/" });
    ask("r2", NAV, { url: "https://b.example/" });
    ask("r3", NAV, { url: "https://c.example/x" });
    expect((await answer("r1")).behavior).toBe("allow");
    const blocked = await answer("r2");
    expect(blocked.behavior).toBe("deny");
    expect(String(blocked.message)).toContain("b.example");
    expect((await answer("r3")).behavior).toBe("allow");
    expect(cards(events)).toHaveLength(0);
    await finish(turn);
  });

  it("never lets a rule cover a page that is not a web address", async () => {
    store({ chat: { s1: { "(not a web page)": "always" } } });
    const { events, turn } = await startTurn();
    ask("r1", NAV, { url: "file:///Users/me/.ssh/id_rsa" });
    await waitFor(() => cards(events).length === 1, "card");
    expect(cards(events)[0].site?.host).toBe("(not a web page)");
    respondClaudeApproval("s1", cards(events)[0].requestId, "deny");
    expect((await answer("r1")).behavior).toBe("deny");
    await finish(turn);
  });

  it("blocks a never site even in Full access, and opens others there", async () => {
    store({ chat: { s1: { "b.example": "never" } } });
    const { events, turn } = await startTurn({ runtimeMode: "full-access" });
    ask("r1", NAV, { url: "https://b.example/" });
    ask("r2", NAV, { url: "https://new.example/" });
    expect((await answer("r1")).behavior).toBe("deny");
    expect((await answer("r2")).behavior).toBe("allow");
    expect(cards(events)).toHaveLength(0);
    await finish(turn);
  });

  it("still refuses a browser tool the chat blocked, whatever the site rule", async () => {
    store({ chat: { s1: { "a.example": "always" } } });
    const blocked = await startTurn({ toolAccess: { never: [NAV] } });
    ask("r1", NAV, { url: "https://a.example/" });
    expect((await answer("r1")).behavior).toBe("deny");
    await finish(blocked.turn);
  });
});
