import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RuntimeMode,
  TurnIntent,
} from "../../../../features/sessions/model/session";
import type { HarnessEvent, HarnessToolAccess } from "../../core/types";

/**
 * Mac test 11.T2.3: Tool access Commands = Always still showed the card for a
 * plain `exec_command` on a local Codex chat.
 *
 * The requests below are the ones Codex 0.161.0 sends, captured against the
 * real CLI with the contract harness's fake Responses server
 * (`tests/cli-contract`). Under Supervised (`untrusted`) Codex asks about
 * every command, and after an accept it runs the command again without the
 * sandbox when the sandbox stops it. An escalation whose model gave no
 * justification carries no `reason`, so it cannot be told from a plain one.
 * Accepting by rule was therefore never safe; the rule now switches the
 * turn's policy to `on-request` with the same sandbox.
 */

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
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => true }));
vi.mock("../../../../platform/tauri/fs", () => ({
  saveGeneratedImage: async () => undefined,
  deleteGeneratedImages: async () => undefined,
}));

const {
  respondCodexApproval,
  sendCodexTurn,
  stopCodexSession,
  __codexTestReset,
} = await import("./codex");
const { buildTurnStartParams, commandsAlwaysPolicy, isPlainCodexApproval } =
  await import("./codexProtocol");

const COMMAND = "item/commandExecution/requestApproval";

/** `exec_command {cmd:"ls src", workdir:"src", sandbox_permissions:"use_default"}`. */
const PLAIN_LS_SRC = {
  kind: "command",
  threadId: "thr_1",
  turnId: "turn_1",
  itemId: "c1",
  startedAtMs: 1791876438066,
  environmentId: "local",
  command: "/bin/bash -lc 'ls src'",
  cwd: "/repo/src",
  commandActions: [{ type: "listFiles", command: "ls src", path: "src" }],
  proposedExecpolicyAmendment: ["ls", "src"],
  availableDecisions: [
    "accept",
    { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["ls", "src"] } },
    "cancel",
  ],
};

/** `exec_command {cmd:"rm -rf src", sandbox_permissions:"require_escalated"}`, no justification. */
const ESCALATED_NO_REASON = {
  kind: "command",
  threadId: "thr_1",
  turnId: "turn_1",
  itemId: "c2",
  startedAtMs: 1791876439263,
  environmentId: "local",
  command: "/bin/bash -lc 'rm -rf src'",
  cwd: "/repo",
  commandActions: [{ type: "unknown", command: "rm -rf src" }],
  proposedExecpolicyAmendment: ["rm", "-rf", "src"],
  availableDecisions: [
    "accept",
    {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ["rm", "-rf", "src"],
      },
    },
    "cancel",
  ],
};

/** The same with `justification: "List the files in src"` and `use_default`. */
const PLAIN_WITH_REASON = {
  ...PLAIN_LS_SRC,
  itemId: "c3",
  reason: "List the files in src",
};

const parse = () =>
  sent.map((line) => JSON.parse(line) as Record<string, unknown>);
const reply = (id: number, result: unknown) =>
  onLine!(JSON.stringify({ id, result }));
const request = (id: number, method: string, params: object) =>
  onLine!(JSON.stringify({ id, method, params }));

const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};
const answered = (id: number) => parse().some((m) => m.id === id);
async function answer(id: number) {
  await waitFor(() => answered(id), `answer to ${id}`);
  return parse().find((m) => m.id === id)!.result;
}
const cards = (events: HarnessEvent[]) =>
  events.filter(
    (e): e is Extract<HarnessEvent, { type: "approval.requested" }> =>
      e.type === "approval.requested",
  );

async function startTurn(options: {
  runtimeMode?: RuntimeMode;
  intent?: TurnIntent;
  toolAccess?: HarnessToolAccess;
}) {
  const events: HarnessEvent[] = [];
  const turn = sendCodexTurn({
    sessionId: "codex-always",
    cwd: "/repo",
    model: "codex:qwen2.5:7b",
    modelSettings: {},
    runtimeMode: options.runtimeMode ?? "supervised",
    intent: options.intent,
    toolAccess: options.toolAccess,
    text: "ls src",
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
  const turnStart = parse().find((m) => m.method === "turn/start")!
    .params as Record<string, unknown>;
  return { events, turn, turnStart };
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
  await stopCodexSession("codex-always");
  __codexTestReset();
});

describe("Codex Commands = Always (11.T2.3)", () => {
  it("cannot tell an escalation without a justification from a plain request", () => {
    // The reason the rule may not accept a command request.
    expect(isPlainCodexApproval(COMMAND, ESCALATED_NO_REASON)).toBe(true);
    expect(isPlainCodexApproval(COMMAND, PLAIN_LS_SRC)).toBe(true);
    // A small model that fills `justification` on a plain call sends a reason.
    expect(isPlainCodexApproval(COMMAND, PLAIN_WITH_REASON)).toBe(false);
    expect(
      isPlainCodexApproval(COMMAND, {
        ...PLAIN_LS_SRC,
        additionalPermissions: { fileSystem: { write: ["/etc"] } },
      }),
    ).toBe(false);
  });

  it("runs Supervised turns as on-request with the same read-only sandbox", async () => {
    const { turnStart, turn } = await startTurn({
      toolAccess: { always: ["codex:command"] },
    });
    expect(turnStart.approvalPolicy).toBe("on-request");
    expect(turnStart.sandboxPolicy).toEqual({ type: "readOnly" });
    await finish(turn);
  });

  it("keeps untrusted without the rule, and for a blocked or ask rule", async () => {
    for (const toolAccess of [
      undefined,
      { never: ["codex:command"] },
      { always: ["codex:file-change"] },
    ]) {
      const { turnStart, turn } = await startTurn({ toolAccess });
      expect(turnStart.approvalPolicy).toBe("untrusted");
      await finish(turn);
      await stopCodexSession("codex-always");
      __codexTestReset();
      sent.length = 0;
    }
  });

  it("never accepts a command request by rule: an escalation still shows the card", async () => {
    const { events, turn } = await startTurn({
      toolAccess: { always: ["codex:command"] },
    });
    request(71, COMMAND, ESCALATED_NO_REASON);
    await waitFor(() => cards(events).length === 1, "card for the escalation");
    expect(answered(71)).toBe(false);
    respondCodexApproval("codex-always", cards(events)[0].requestId, "deny");
    expect(await answer(71)).toEqual({ decision: "decline" });
    await finish(turn);
  });

  it("leaves a plan turn read only with no approvals asked", () => {
    const params = buildTurnStartParams({
      threadId: "t",
      runtimeMode: "supervised",
      prompt: "plan it",
      intent: "plan",
      commandsAlways: true,
    });
    expect(params.approvalPolicy).toBe("never");
    expect(params.sandboxPolicy).toEqual({ type: "readOnly" });
  });

  it("changes no other mode", () => {
    expect(commandsAlwaysPolicy("on-request", true)).toBe("on-request");
    expect(commandsAlwaysPolicy("never", true)).toBe("never");
    expect(commandsAlwaysPolicy("untrusted", false)).toBe("untrusted");
    for (const runtimeMode of [
      "auto-accept-edits",
      "auto",
      "full-access",
    ] as const) {
      const on = buildTurnStartParams({
        threadId: "t",
        runtimeMode,
        prompt: "x",
        commandsAlways: true,
      });
      const off = buildTurnStartParams({
        threadId: "t",
        runtimeMode,
        prompt: "x",
      });
      expect(on).toEqual(off);
    }
  });

  it("puts any command request Codex still sends to the card, a plain one in a subfolder too", async () => {
    // The 7B set workdir to `src`. Under on-request Codex runs such a command
    // in its sandbox without asking; a request it does send goes to the user.
    const { events, turn } = await startTurn({
      toolAccess: { always: ["codex:command"] },
    });
    request(72, COMMAND, PLAIN_LS_SRC);
    await waitFor(() => cards(events).length === 1, "card");
    expect(cards(events)[0].title).toBeTruthy();
    respondCodexApproval("codex-always", cards(events)[0].requestId, "allow");
    expect(await answer(72)).toEqual({ decision: "accept" });
    await finish(turn);
  });
});
