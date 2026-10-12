import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RuntimeMode,
  TurnIntent,
} from "../../../../features/sessions/model/session";
import type { HarnessEvent, HarnessToolAccess } from "../../core/types";

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("./codexStore", () => ({
  prepareCodexMonoContext: async () => ({ config: {}, hasThread: true }),
}));
vi.mock("../../core/child", () => ({
  resolveCodexBinary: async () => ({ path: "/fake/codex" }),
  spawnChild: async () => undefined,
  restoreMonoCodexAgentState: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
}));
// The disk half of the chat-folder check (lane 5): every path counts as inside.
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => true }));
vi.mock("../../../../platform/tauri/fs", () => ({
  saveGeneratedImage: async () => undefined,
  deleteGeneratedImages: async () => undefined,
}));

const {
  compactCodexContext,
  respondCodexApproval,
  sendCodexTurn,
  setCodexToolAccess,
  stopCodexSession,
  __codexTestReset,
} = await import("./codex");
const { isPlainCodexApproval, mapApprovalRequest } =
  await import("./codexProtocol");

const COMMAND = "item/commandExecution/requestApproval";
const FILE_CHANGE = "item/fileChange/requestApproval";
const PERMISSIONS = "item/permissions/requestApproval";

function parse() {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function reply(id: number, result: unknown) {
  onLine!(JSON.stringify({ id, result }));
}

function request(id: number, method: string, params: object) {
  onLine!(JSON.stringify({ id, method, params }));
}

const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

/** The result sent back for one server request, once it was. */
async function answer(id: number) {
  await waitFor(() => parse().some((m) => m.id === id), `answer to ${id}`);
  return parse().find((m) => m.id === id)!.result;
}

const answered = (id: number) => parse().some((m) => m.id === id);

const cards = (events: HarnessEvent[]) =>
  events.filter((event) => event.type === "approval.requested");

type TurnOptions = {
  runtimeMode?: RuntimeMode;
  intent?: TurnIntent;
  toolAccess?: HarnessToolAccess;
};

async function startTurn(options: TurnOptions = {}) {
  const events: HarnessEvent[] = [];
  const turn = sendCodexTurn({
    sessionId: "codex-rules",
    cwd: "/repo",
    model: "codex:gpt-5.4",
    modelSettings: {},
    runtimeMode: options.runtimeMode ?? "supervised",
    intent: options.intent,
    toolAccess: options.toolAccess,
    text: "do the work",
    attachments: [],
    onEvent: (event) => events.push(event),
  });
  for (const [method, result] of [
    ["initialize", {}],
    ["thread/start", { thread: { id: "thr_1" } }],
    ["turn/start", { turn: { id: "turn_1", status: "inProgress" } }],
  ] as const) {
    await waitFor(() => parse().some((m) => m.method === method), method);
    reply(parse().find((m) => m.method === method)!.id as number, result);
  }
  return { events, turn };
}

async function finish(turn: Promise<void>) {
  onLine!(
    JSON.stringify({
      method: "turn/completed",
      params: { turn: { id: "turn_1", status: "completed" } },
    }),
  );
  await turn;
}

beforeEach(() => {
  sent.length = 0;
  onLine = undefined;
});

afterEach(async () => {
  await stopCodexSession("codex-rules");
  __codexTestReset();
});

describe("Codex approval requests and the tool they are about", () => {
  it("names commands and patches, and nothing for a sandbox escalation", () => {
    expect(
      mapApprovalRequest(COMMAND, { itemId: "c", command: "ls" }, 1)?.event,
    ).toMatchObject({ tool: { key: "codex:command", label: "Commands" } });
    expect(
      mapApprovalRequest(FILE_CHANGE, { itemId: "f" }, 2)?.event,
    ).toMatchObject({
      tool: { key: "codex:file-change", label: "File edits" },
    });
    expect(
      mapApprovalRequest(PERMISSIONS, { itemId: "p" }, 3)?.event,
    ).not.toHaveProperty("tool");
  });

  it("tells a plain request from one that asks for more access", () => {
    expect(isPlainCodexApproval(COMMAND, { command: "ls" })).toBe(true);
    expect(
      isPlainCodexApproval(COMMAND, { command: "ls", kind: "command" }),
    ).toBe(true);
    expect(isPlainCodexApproval(FILE_CHANGE, { itemId: "f" })).toBe(true);
    // A retry outside the sandbox or a model's escalation comes with a reason.
    expect(
      isPlainCodexApproval(COMMAND, {
        command: "curl example.com",
        reason: "command failed; retry without sandbox?",
      }),
    ).toBe(false);
    expect(
      isPlainCodexApproval(COMMAND, {
        command: "curl example.com",
        networkApprovalContext: { host: "example.com", protocol: "https" },
      }),
    ).toBe(false);
    expect(
      isPlainCodexApproval(COMMAND, { command: "y", kind: "writeStdin" }),
    ).toBe(false);
    expect(isPlainCodexApproval(FILE_CHANGE, { grantRoot: "/etc" })).toBe(
      false,
    );
    expect(
      isPlainCodexApproval(FILE_CHANGE, { reason: "extra write access" }),
    ).toBe(false);
    expect(isPlainCodexApproval(PERMISSIONS, { permissions: {} })).toBe(false);
    expect(isPlainCodexApproval(COMMAND, null)).toBe(false);
  });
});

describe("Codex per-chat tool rules", () => {
  it("accepts an always-allowed command without a card", async () => {
    const { events, turn } = await startTurn({
      toolAccess: { always: ["codex:command"] },
    });
    request(91, COMMAND, { itemId: "cmd_1", command: "npm test" });
    expect(await answer(91)).toEqual({ decision: "accept" });
    expect(cards(events)).toHaveLength(0);
    // A patch has no rule and is still put to the user.
    request(92, FILE_CHANGE, { itemId: "edit_1" });
    await waitFor(() => cards(events).length === 1, "card for the patch");
    expect(answered(92)).toBe(false);
    expect(cards(events)[0]).toMatchObject({
      tool: { key: "codex:file-change", label: "File edits" },
    });
    respondCodexApproval("codex-rules", cards(events)[0].requestId, "allow");
    expect(await answer(92)).toEqual({ decision: "accept" });
    await finish(turn);
  });

  it("accepts an always-allowed patch without a card", async () => {
    const { events, turn } = await startTurn({
      toolAccess: { always: ["codex:file-change"] },
    });
    // The rule answers only for files it knows, inside the chat's folder.
    onLine!(
      JSON.stringify({
        method: "item/started",
        params: {
          threadId: "thr_1",
          item: {
            type: "fileChange",
            id: "edit_1",
            changes: [{ path: "/repo/src/a.ts", kind: { type: "update" } }],
            status: "inProgress",
          },
        },
      }),
    );
    request(91, FILE_CHANGE, { itemId: "edit_1" });
    expect(await answer(91)).toEqual({ decision: "accept" });
    expect(cards(events)).toHaveLength(0);
    await finish(turn);
  });

  it("still asks when an always-allowed request wants more access", async () => {
    const { events, turn } = await startTurn({
      toolAccess: { always: ["codex:command", "codex:file-change"] },
    });
    request(91, COMMAND, {
      itemId: "cmd_1",
      command: "curl example.com",
      reason: "command failed; retry without sandbox?",
    });
    request(92, COMMAND, {
      itemId: "cmd_2",
      command: "curl example.com",
      networkApprovalContext: { host: "example.com", protocol: "https" },
    });
    request(93, FILE_CHANGE, { itemId: "edit_1", grantRoot: "/etc" });
    await waitFor(() => cards(events).length === 3, "three cards");
    expect([91, 92, 93].some(answered)).toBe(false);
    for (const card of cards(events)) {
      respondCodexApproval("codex-rules", card.requestId, "deny");
    }
    await answer(93);
    await finish(turn);
  });

  it("declines a blocked command without a card, in any mode", async () => {
    for (const runtimeMode of ["supervised", "full-access"] as const) {
      const { events, turn } = await startTurn({
        runtimeMode,
        toolAccess: { never: ["codex:command"] },
      });
      request(91, COMMAND, { itemId: "cmd_1", command: "rm -rf build" });
      expect(await answer(91)).toEqual({ decision: "decline" });
      // Declining is safe whatever else the request asks for.
      request(92, COMMAND, {
        itemId: "cmd_2",
        command: "curl example.com",
        reason: "command failed; retry without sandbox?",
      });
      expect(await answer(92)).toEqual({ decision: "decline" });
      expect(cards(events)).toHaveLength(0);
      await finish(turn);
      await stopCodexSession("codex-rules");
      __codexTestReset();
      sent.length = 0;
    }
  });

  it("never answers a sandbox escalation by rule", async () => {
    const { events, turn } = await startTurn({
      toolAccess: {
        always: ["codex:command", "codex:file-change"],
      },
    });
    const permissions = { network: { enabled: true } };
    request(91, PERMISSIONS, { itemId: "perm_1", permissions });
    await waitFor(() => cards(events).length === 1, "permission card");
    expect(answered(91)).toBe(false);
    expect(cards(events)[0]).not.toHaveProperty("tool");
    respondCodexApproval("codex-rules", cards(events)[0].requestId, "deny");
    expect(await answer(91)).toEqual({ permissions: {} });
    await finish(turn);
  });

  it("leaves an MCP confirmation on the existing path", async () => {
    const { events, turn } = await startTurn({
      toolAccess: { always: ["codex:command"] },
    });
    request(91, "mcpServer/elicitation/request", {
      mode: "form",
      serverName: "exa",
      message: 'Allow Codex to run tool "web_search"?',
      requestedSchema: { type: "object", properties: {} },
    });
    await waitFor(() => cards(events).length === 1, "MCP card");
    expect(answered(91)).toBe(false);
    // Codex names no tool on the request, so no rule can be kept for it.
    expect(cards(events)[0]).not.toHaveProperty("tool");
    respondCodexApproval("codex-rules", cards(events)[0].requestId, "deny");
    expect(await answer(91)).toMatchObject({ action: "decline" });
    await finish(turn);
  });

  it("keeps a plan turn's denial ahead of an always rule", async () => {
    const { events, turn } = await startTurn({
      intent: "plan",
      toolAccess: { always: ["codex:command", "codex:file-change"] },
    });
    request(91, COMMAND, { itemId: "cmd_1", command: "npm test" });
    expect(await answer(91)).toEqual({ decision: "decline" });
    request(92, FILE_CHANGE, { itemId: "edit_1" });
    expect(await answer(92)).toEqual({ decision: "decline" });
    expect(cards(events)).toHaveLength(0);
    await finish(turn);
  });

  it("applies a rule set in the middle of a turn to the next request", async () => {
    const { events, turn } = await startTurn();
    request(91, COMMAND, { itemId: "cmd_1", command: "ls" });
    await waitFor(() => cards(events).length === 1, "first card");
    respondCodexApproval("codex-rules", cards(events)[0].requestId, "allow");
    await answer(91);

    setCodexToolAccess("codex-rules", { always: ["codex:command"] });
    request(92, COMMAND, { itemId: "cmd_2", command: "pwd" });
    expect(await answer(92)).toEqual({ decision: "accept" });

    setCodexToolAccess("codex-rules", { never: ["codex:command"] });
    request(93, COMMAND, { itemId: "cmd_3", command: "whoami" });
    expect(await answer(93)).toEqual({ decision: "decline" });

    setCodexToolAccess("codex-rules", undefined);
    request(94, COMMAND, { itemId: "cmd_4", command: "date" });
    await waitFor(() => cards(events).length === 2, "card after the reset");
    expect(answered(94)).toBe(false);
    respondCodexApproval("codex-rules", cards(events)[1].requestId, "allow");
    await answer(94);
    await finish(turn);
  });

  it("declines the cards on screen for a tool that gets blocked, and no others", async () => {
    const { events, turn } = await startTurn();
    request(91, COMMAND, { itemId: "cmd_1", command: "ls" });
    request(92, FILE_CHANGE, { itemId: "edit_1" });
    request(93, PERMISSIONS, { itemId: "perm_1", permissions: {} });
    await waitFor(() => cards(events).length === 3, "three cards");

    setCodexToolAccess("codex-rules", { never: ["codex:command"] });
    expect(await answer(91)).toEqual({ decision: "decline" });
    expect(events).toContainEqual({
      type: "approval.resolved",
      requestId: cards(events)[0].requestId,
      decision: "deny",
    });
    expect(answered(92)).toBe(false);
    expect(answered(93)).toBe(false);

    // Always allowing patches now leaves the patch card for the user.
    setCodexToolAccess("codex-rules", {
      always: ["codex:file-change"],
      never: ["codex:command"],
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(answered(92)).toBe(false);
    respondCodexApproval("codex-rules", cards(events)[1].requestId, "allow");
    respondCodexApproval("codex-rules", cards(events)[2].requestId, "deny");
    await answer(92);
    await answer(93);
    await finish(turn);
  });

  it("takes the rules of the next turn and of a compaction", async () => {
    const first = await startTurn({
      toolAccess: { always: ["codex:command"] },
    });
    await finish(first.turn);

    const events: HarnessEvent[] = [];
    const second = sendCodexTurn({
      sessionId: "codex-rules",
      cwd: "/repo",
      model: "codex:gpt-5.4",
      modelSettings: {},
      runtimeMode: "supervised",
      toolAccess: { never: ["codex:command"] },
      text: "again",
      attachments: [],
      onEvent: (event) => events.push(event),
    });
    await waitFor(
      () => parse().filter((m) => m.method === "turn/start").length === 2,
      "second turn",
    );
    reply(parse().filter((m) => m.method === "turn/start")[1].id as number, {
      turn: { id: "turn_1", status: "inProgress" },
    });
    request(91, COMMAND, { itemId: "cmd_1", command: "ls" });
    expect(await answer(91)).toEqual({ decision: "decline" });
    await finish(second);

    // A compaction with no rules clears them for the live thread.
    const compaction = compactCodexContext({
      sessionId: "codex-rules",
      cwd: "/repo",
      model: "codex:gpt-5.4",
      modelSettings: {},
      runtimeMode: "supervised",
      onEvent: (event) => events.push(event),
    });
    await waitFor(
      () => parse().some((m) => m.method === "thread/compact/start"),
      "compaction",
    );
    request(92, COMMAND, { itemId: "cmd_2", command: "ls" });
    await waitFor(() => cards(events).length === 1, "card during compaction");
    expect(answered(92)).toBe(false);
    await stopCodexSession("codex-rules");
    await compaction.catch(() => undefined);
  });

  it("ignores a rule change for a session with no live thread", () => {
    expect(() =>
      setCodexToolAccess("gone", { never: ["codex:command"] }),
    ).not.toThrow();
  });
});
