import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RuntimeMode,
  TurnIntent,
} from "../../../../features/sessions/model/session";
import type { HarnessEvent, HarnessToolAccess } from "../../core/types";

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;
/** What the Rust disk check answers: by default, whatever is under /repo or /docs. */
let disk = vi.fn(
  async (_cmd: string, args: { roots: string[]; paths: string[] }) =>
    args.paths.every((p) => !p.includes("/link-out/")),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: { roots: string[]; paths: string[] }) =>
    disk(cmd, args),
}));
const keptImages = vi.fn(async (_input: unknown) => undefined);
vi.mock("../../../../features/tool-images/data/toolImageStore", () => ({
  keepToolResultImages: (input: unknown) => keptImages(input),
}));
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
vi.mock("../../../../platform/tauri/fs", () => ({
  saveGeneratedImage: async () => undefined,
  deleteGeneratedImages: async () => undefined,
}));

const {
  respondCodexApproval,
  respondCodexQuestion,
  sendCodexTurn,
  stopCodexSession,
  __codexTestReset,
} = await import("./codex");
const { toCodexApprovalDecision } = await import("./codexProtocol");

const COMMAND = "item/commandExecution/requestApproval";
const FILE_CHANGE = "item/fileChange/requestApproval";
const SESSION = "codex-folders";

const parse = () =>
  sent.map((line) => JSON.parse(line) as Record<string, unknown>);
const reply = (id: number, result: unknown) =>
  onLine!(JSON.stringify({ id, result }));
const request = (id: number, method: string, params: object) =>
  onLine!(JSON.stringify({ id, method, params }));
const notify = (method: string, params: object) =>
  onLine!(JSON.stringify({ method, params }));

const fileItem = (id: string, paths: string[]) =>
  notify("item/started", {
    threadId: "thr_1",
    item: {
      type: "fileChange",
      id,
      changes: paths.map((path) => ({ path, kind: { type: "update" } })),
      status: "inProgress",
    },
  });

const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

async function answer(id: number) {
  await waitFor(() => parse().some((m) => m.id === id), `answer to ${id}`);
  return parse().find((m) => m.id === id)!.result;
}
const answered = (id: number) => parse().some((m) => m.id === id);
const cards = (events: HarnessEvent[]) =>
  events.filter(
    (e): e is Extract<HarnessEvent, { type: "approval.requested" }> =>
      e.type === "approval.requested",
  );

async function startTurn(
  options: {
    runtimeMode?: RuntimeMode;
    intent?: TurnIntent;
    toolAccess?: HarnessToolAccess;
    extraDirs?: string[];
  } = {},
) {
  const events: HarnessEvent[] = [];
  const turn = sendCodexTurn({
    sessionId: SESSION,
    cwd: "/repo",
    model: "codex:gpt-5.4",
    modelSettings: {},
    runtimeMode: options.runtimeMode ?? "supervised",
    intent: options.intent,
    toolAccess: options.toolAccess,
    extraDirs: options.extraDirs,
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
  notify("turn/completed", { turn: { id: "turn_1", status: "completed" } });
  await turn;
}

beforeEach(() => {
  sent.length = 0;
  onLine = undefined;
  disk = vi.fn(async (_cmd, args) =>
    args.paths.every((p) => !p.includes("/link-out/")),
  );
});

afterEach(async () => {
  await stopCodexSession(SESSION);
  __codexTestReset();
});

describe("toCodexApprovalDecision", () => {
  it("sends acceptForSession only when asked, for commands and file changes", () => {
    expect(toCodexApprovalDecision("allow", "file-change")).toBe("accept");
    expect(
      toCodexApprovalDecision("allow", "file-change", { forSession: true }),
    ).toBe("acceptForSession");
    expect(
      toCodexApprovalDecision("allow", "command", { forSession: true }),
    ).toBe("acceptForSession");
    expect(
      toCodexApprovalDecision("allow", "permissions", { forSession: true }),
    ).toBe("accept");
    expect(
      toCodexApprovalDecision("deny", "file-change", { forSession: true }),
    ).toBe("decline");
  });
});

describe("Codex always rule held to the chat's folders", () => {
  it("answers a patch inside the working folder without a card", async () => {
    const { events, turn } = await startTurn({
      toolAccess: { always: ["codex:file-change"] },
    });
    fileItem("e1", ["/repo/src/a.ts", "/repo/name with spaces.md"]);
    request(91, FILE_CHANGE, { itemId: "e1" });
    expect(await answer(91)).toEqual({ decision: "accept" });
    expect(cards(events)).toHaveLength(0);
    expect(disk).toHaveBeenCalledWith("approval_paths_within", {
      roots: ["/repo"],
      paths: ["/repo/src/a.ts", "/repo/name with spaces.md"],
    });
    await finish(turn);
  });

  it("answers a patch in an added folder, also one added mid-session", async () => {
    const { events, turn } = await startTurn({
      toolAccess: { always: ["codex:file-change"] },
      extraDirs: ["/docs"],
    });
    fileItem("e1", ["/docs/guide.md"]);
    request(91, FILE_CHANGE, { itemId: "e1" });
    expect(await answer(91)).toEqual({ decision: "accept" });
    expect(cards(events)).toHaveLength(0);
    await finish(turn);
  });

  it("shows the card for a patch outside the chat's folders", async () => {
    const { events, turn } = await startTurn({
      toolAccess: { always: ["codex:file-change"] },
    });
    fileItem("e1", ["/repo/a.ts", "/Users/me/.zshrc"]);
    request(91, FILE_CHANGE, { itemId: "e1" });
    await waitFor(() => cards(events).length === 1, "card");
    expect(answered(91)).toBe(false);
    respondCodexApproval(SESSION, cards(events)[0].requestId, "deny");
    expect(await answer(91)).toEqual({ decision: "decline" });
    await finish(turn);
  });

  it("shows the card for .., a symlink out, or files it never saw", async () => {
    const { events, turn } = await startTurn({
      toolAccess: { always: ["codex:file-change"] },
    });
    fileItem("e1", ["/repo/../etc/hosts"]);
    fileItem("e2", ["/repo/link-out/x"]);
    request(91, FILE_CHANGE, { itemId: "e1" });
    request(92, FILE_CHANGE, { itemId: "e2" });
    request(93, FILE_CHANGE, { itemId: "never-started" });
    await waitFor(() => cards(events).length === 3, "three cards");
    expect([91, 92, 93].some(answered)).toBe(false);
    for (const card of cards(events))
      respondCodexApproval(SESSION, card.requestId, "deny");
    await answer(93);
    await finish(turn);
  });

  it("fails closed when the disk check throws", async () => {
    disk = vi.fn(async () => {
      throw new Error("ipc down");
    });
    const { events, turn } = await startTurn({
      toolAccess: { always: ["codex:file-change"] },
    });
    fileItem("e1", ["/repo/a.ts"]);
    request(91, FILE_CHANGE, { itemId: "e1" });
    await waitFor(() => cards(events).length === 1, "card");
    respondCodexApproval(SESSION, cards(events)[0].requestId, "deny");
    await answer(91);
    await finish(turn);
  });

  it("keeps a plan turn read only whatever the rule", async () => {
    const { events, turn } = await startTurn({
      intent: "plan",
      toolAccess: { always: ["codex:file-change"] },
    });
    fileItem("e1", ["/repo/a.ts"]);
    request(91, FILE_CHANGE, { itemId: "e1" });
    expect(await answer(91)).toEqual({ decision: "decline" });
    expect(cards(events)).toHaveLength(0);
    await finish(turn);
  });

  it("still asks for a command when only file edits are allowed", async () => {
    const { events, turn } = await startTurn({
      toolAccess: { always: ["codex:file-change"] },
    });
    request(91, COMMAND, { itemId: "c1", command: "ls" });
    await waitFor(() => cards(events).length === 1, "card");
    respondCodexApproval(SESSION, cards(events)[0].requestId, "deny");
    await answer(91);
    await finish(turn);
  });
});

describe('"Allow for this chat" on the card', () => {
  it("grants a patch inside the folders for the Codex session", async () => {
    const { events, turn } = await startTurn();
    fileItem("e1", ["/repo/a.ts"]);
    request(91, FILE_CHANGE, { itemId: "e1" });
    await waitFor(() => cards(events).length === 1, "card");
    respondCodexApproval(SESSION, cards(events)[0].requestId, "allow", {
      forChat: true,
    });
    expect(await answer(91)).toEqual({ decision: "acceptForSession" });
    await finish(turn);
  });

  it("answers a patch outside the folders once only", async () => {
    const { events, turn } = await startTurn();
    fileItem("e1", ["/tmp/out.txt"]);
    request(91, FILE_CHANGE, { itemId: "e1" });
    await waitFor(() => cards(events).length === 1, "card");
    respondCodexApproval(SESSION, cards(events)[0].requestId, "allow", {
      forChat: true,
    });
    expect(await answer(91)).toEqual({ decision: "accept" });
    await finish(turn);
  });

  it("never grants a request that asks for more for the session", async () => {
    const { events, turn } = await startTurn();
    fileItem("e1", ["/repo/a.ts"]);
    request(91, FILE_CHANGE, { itemId: "e1", grantRoot: "/" });
    request(92, COMMAND, {
      itemId: "c1",
      command: "npm install",
      reason: "retry without sandbox?",
    });
    await waitFor(() => cards(events).length === 2, "two cards");
    for (const card of cards(events))
      respondCodexApproval(SESSION, card.requestId, "allow", { forChat: true });
    expect(await answer(91)).toEqual({ decision: "accept" });
    expect(await answer(92)).toEqual({ decision: "accept" });
    await finish(turn);
  });

  it("grants a plain command for the session", async () => {
    const { events, turn } = await startTurn();
    request(91, COMMAND, { itemId: "c1", command: "npm test" });
    await waitFor(() => cards(events).length === 1, "card");
    respondCodexApproval(SESSION, cards(events)[0].requestId, "allow", {
      forChat: true,
    });
    expect(await answer(91)).toEqual({ decision: "acceptForSession" });
    await finish(turn);
  });

  it("plain Allow and Deny are unchanged", async () => {
    const { events, turn } = await startTurn();
    fileItem("e1", ["/repo/a.ts"]);
    request(91, FILE_CHANGE, { itemId: "e1" });
    request(92, FILE_CHANGE, { itemId: "e1" });
    await waitFor(() => cards(events).length === 2, "two cards");
    respondCodexApproval(SESSION, cards(events)[0].requestId, "allow");
    respondCodexApproval(SESSION, cards(events)[1].requestId, "deny", {
      forChat: true,
    });
    expect(await answer(91)).toEqual({ decision: "accept" });
    expect(await answer(92)).toEqual({ decision: "decline" });
    await finish(turn);
  });
});

describe("MCP sign-in requests", () => {
  const ELICIT = "mcpServer/elicitation/request";
  const questions = (events: HarnessEvent[]) =>
    events.filter(
      (e): e is Extract<HarnessEvent, { type: "question.asked" }> =>
        e.type === "question.asked",
    );
  const formParams = {
    threadId: "thr_1",
    turnId: "turn_1",
    serverName: "linear",
    mode: "form",
    message: "Which workspace?",
    requestedSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", enum: ["acme", "home"] },
        note: { type: "string" },
      },
      required: ["workspace"],
    },
  };
  const urlParams = {
    threadId: "thr_1",
    turnId: "turn_1",
    serverName: "github",
    mode: "url",
    message: "Sign in to GitHub",
    url: "https://github.com/login/device?state=abc",
    elicitationId: "el_1",
  };

  it("shows a form as a question card and sends typed content", async () => {
    const { events, turn } = await startTurn();
    request(91, ELICIT, formParams);
    await waitFor(() => questions(events).length === 1, "question card");
    const card = questions(events)[0];
    expect(card.title).toBe("linear (MCP server) asks: Which workspace?");
    expect(card.questions.map((q) => q.id)).toEqual(["workspace", "note"]);
    respondCodexQuestion(SESSION, card.requestId, {
      kind: "answered",
      answers: { workspace: ["acme"] },
      custom: { note: "for the sprint" },
    });
    expect(await answer(91)).toEqual({
      action: "accept",
      content: { workspace: "acme", note: "for the sprint" },
      _meta: null,
    });
    await finish(turn);
  });

  it("declines a skipped form, and one whose answer does not fit", async () => {
    const { events, turn } = await startTurn();
    request(91, ELICIT, formParams);
    await waitFor(() => questions(events).length === 1, "first card");
    respondCodexQuestion(SESSION, questions(events)[0].requestId, {
      kind: "skipped",
    });
    expect(await answer(91)).toEqual({
      action: "decline",
      content: null,
      _meta: null,
    });
    request(92, ELICIT, formParams);
    await waitFor(() => questions(events).length === 2, "second card");
    respondCodexQuestion(SESSION, questions(events)[1].requestId, {
      kind: "answered",
      answers: {},
    });
    expect(await answer(92)).toMatchObject({ action: "decline" });
    expect(
      events.some(
        (e) => e.type === "status" && e.text.includes("workspace is required"),
      ),
    ).toBe(true);
    await finish(turn);
  });

  it("never answers a form or a sign-in by itself, even in Full access", async () => {
    const { events, turn } = await startTurn({ runtimeMode: "full-access" });
    request(91, ELICIT, formParams);
    request(92, ELICIT, urlParams);
    await waitFor(
      () => questions(events).length === 1 && cards(events).length === 1,
      "both cards",
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(answered(91) || answered(92)).toBe(false);
    respondCodexQuestion(SESSION, questions(events)[0].requestId, {
      kind: "skipped",
    });
    respondCodexApproval(SESSION, cards(events)[0].requestId, "deny");
    await answer(92);
    await finish(turn);
  });

  it("shows a browser sign-in card and accepts once the page is opened", async () => {
    const { events, turn } = await startTurn();
    request(91, ELICIT, urlParams);
    await waitFor(() => cards(events).length === 1, "sign-in card");
    const card = cards(events)[0];
    expect(card.title).toBe(
      "github (MCP server) asks you to sign in at github.com",
    );
    expect(card.signIn).toEqual({
      server: "github",
      message: "Sign in to GitHub",
      url: "https://github.com/login/device?state=abc",
      host: "github.com",
    });
    expect(card.tool).toBeUndefined();
    respondCodexApproval(SESSION, card.requestId, "allow");
    expect(await answer(91)).toEqual({
      action: "accept",
      content: null,
      _meta: null,
    });
    await finish(turn);
  });

  it("declines a sign-in the user cancels", async () => {
    const { events, turn } = await startTurn();
    request(91, ELICIT, urlParams);
    await waitFor(() => cards(events).length === 1, "sign-in card");
    respondCodexApproval(SESSION, cards(events)[0].requestId, "deny");
    expect(await answer(91)).toMatchObject({ action: "decline" });
    await finish(turn);
  });

  it("cancels, with a note, a page that is not https or a device check", async () => {
    const { events, turn } = await startTurn();
    request(91, ELICIT, { ...urlParams, url: "http://evil.example/login" });
    request(92, ELICIT, {
      threadId: "thr_1",
      serverName: "x",
      mode: "openai/userVerification",
      title: "t",
      description: "d",
      challenge: "c",
    });
    expect(await answer(91)).toMatchObject({ action: "cancel" });
    expect(await answer(92)).toMatchObject({ action: "cancel" });
    expect(cards(events)).toHaveLength(0);
    expect(
      events.filter(
        (e) => e.type === "status" && e.text.includes("cannot show faithfully"),
      ),
    ).toHaveLength(2);
    await finish(turn);
  });

  it("clears a sign-in card the server withdraws, without answering", async () => {
    const { events, turn } = await startTurn();
    request(91, ELICIT, urlParams);
    await waitFor(() => cards(events).length === 1, "sign-in card");
    notify("serverRequest/resolved", { threadId: "thr_1", requestId: 91 });
    await waitFor(
      () =>
        events.some(
          (e) => e.type === "approval.resolved" && e.decision === "cancelled",
        ),
      "withdrawn",
    );
    expect(answered(91)).toBe(false);
    await finish(turn);
  });
});

describe("Codex MCP screenshots", () => {
  it("keeps the images of a finished MCP call for the transcript", async () => {
    keptImages.mockClear();
    const { turn } = await startTurn();
    notify("item/completed", {
      threadId: "thr_1",
      item: {
        type: "mcpToolCall",
        id: "mcp_1",
        server: "playwright",
        tool: "browser_take_screenshot",
        status: "completed",
        arguments: {},
        result: {
          content: [{ type: "image", data: "iVBORw0K", mimeType: "image/png" }],
        },
      },
    });
    await waitFor(() => keptImages.mock.calls.length === 1, "kept image");
    expect(keptImages.mock.calls[0][0]).toMatchObject({
      sessionId: SESSION,
      callId: "mcp_1",
      images: [{ data: "iVBORw0K", mimeType: "image/png" }],
    });
    await finish(turn);
  });
});
