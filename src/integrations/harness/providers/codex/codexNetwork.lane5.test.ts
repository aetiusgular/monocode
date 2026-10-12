import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeMode } from "../../../../features/sessions/model/session";
import type { HarnessEvent } from "../../core/types";

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
vi.mock("../../../../platform/tauri/fs", () => ({
  saveGeneratedImage: async () => undefined,
  deleteGeneratedImages: async () => undefined,
}));

const {
  respondCodexApproval,
  sendCodexTurn,
  setCodexToolAccess,
  stopCodexSession,
  __codexTestReset,
} = await import("./codex");
const { isPlainCodexApproval, mapApprovalRequest } =
  await import("./codexProtocol");

const COMMAND = "item/commandExecution/requestApproval";
const SESSION = "codex-net";

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

async function answer(id: number) {
  await waitFor(() => parse().some((m) => m.id === id), `answer to ${id}`);
  return parse().find((m) => m.id === id)!.result;
}

const cards = (events: HarnessEvent[]) =>
  events.filter(
    (event): event is Extract<HarnessEvent, { type: "approval.requested" }> =>
      event.type === "approval.requested",
  );

async function startTurn(
  options: {
    runtimeMode?: RuntimeMode;
    modelProvider?: string;
    permissionsProfile?: string;
    threadId?: string;
  } = {},
) {
  const events: HarnessEvent[] = [];
  const before = sent.length;
  const turn = sendCodexTurn({
    sessionId: SESSION,
    cwd: "/repo",
    model: "codex:gpt-5.4",
    modelSettings: {},
    runtimeMode: options.runtimeMode ?? "supervised",
    modelProvider: options.modelProvider,
    permissionsProfile: options.permissionsProfile,
    text: "do the work",
    attachments: [],
    onEvent: (event) => events.push(event),
  });
  const fresh = () =>
    sent.slice(before).map((l) => JSON.parse(l) as Record<string, unknown>);
  const methods: Array<[string, unknown]> = [
    ["thread/start", { thread: { id: options.threadId ?? "thr_1" } }],
    ["turn/start", { turn: { id: "turn_1", status: "inProgress" } }],
  ];
  for (const [method, result] of methods) {
    await waitFor(
      () =>
        fresh().some((m) => m.method === "initialize" && !answeredId(m.id)) ||
        fresh().some((m) => m.method === method),
      method,
    );
    const init = fresh().find(
      (m) => m.method === "initialize" && !answeredId(m.id),
    );
    if (init) {
      reply(init.id as number, {});
      answeredIds.add(init.id as number);
      await waitFor(() => fresh().some((m) => m.method === method), method);
    }
    const msg = fresh().find((m) => m.method === method)!;
    reply(msg.id as number, result);
  }
  return { events, turn, fresh };
}

const answeredIds = new Set<number>();
const answeredId = (id: unknown) => answeredIds.has(id as number);

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
  answeredIds.clear();
  onLine = undefined;
});

afterEach(async () => {
  await stopCodexSession(SESSION);
  __codexTestReset();
});

const NETWORK_PARAMS = {
  itemId: "cmd_1",
  command: "curl https://registry.npmjs.org",
  networkApprovalContext: { host: "registry.npmjs.org", protocol: "https" },
  proposedNetworkPolicyAmendments: [
    { host: "registry.npmjs.org", action: "allow" },
    { host: "registry.npmjs.org", action: "deny" },
  ],
};

describe("mapping a network approval", () => {
  it("carries the host, protocol and proposed amendments", () => {
    const mapped = mapApprovalRequest(COMMAND, NETWORK_PARAMS, 4);
    expect(mapped?.event.network).toEqual({
      host: "registry.npmjs.org",
      protocol: "https",
      amendments: [
        { host: "registry.npmjs.org", action: "allow" },
        { host: "registry.npmjs.org", action: "deny" },
      ],
    });
    // Still never plain: an "always allow commands" rule never answers it.
    expect(isPlainCodexApproval(COMMAND, NETWORK_PARAMS)).toBe(false);
  });

  it("has no network field without a network context", () => {
    const mapped = mapApprovalRequest(COMMAND, { command: "ls" }, 5);
    expect(mapped?.event).not.toHaveProperty("network");
  });

  it("drops a host that is not a host, or an unknown protocol", () => {
    const bad = (host: unknown, protocol: unknown) =>
      mapApprovalRequest(
        COMMAND,
        { command: "x", networkApprovalContext: { host, protocol } },
        6,
      )?.event.network;
    expect(bad("<img src=x onerror=alert(1)>", "https")).toBeUndefined();
    expect(bad("a".repeat(300), "https")).toBeUndefined();
    expect(bad("example.com", "ftp")).toBeUndefined();
    expect(bad(7, "https")).toBeUndefined();
    expect(bad("[::1]:8080", "socks5Tcp")).toEqual({
      host: "[::1]:8080",
      protocol: "socks5Tcp",
    });
  });

  it("keeps at most 8 well-formed amendments", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      host: `h${i}.example`,
      action: "allow",
    }));
    const mapped = mapApprovalRequest(
      COMMAND,
      {
        command: "x",
        networkApprovalContext: { host: "h0.example", protocol: "http" },
        proposedNetworkPolicyAmendments: [
          { host: "<b>", action: "allow" },
          { host: "ok.example", action: "maybe" },
          ...many,
        ],
      },
      7,
    );
    expect(mapped?.event.network?.amendments).toHaveLength(6);
  });
});

describe("answering a network approval", () => {
  it("sends the always-allow amendment exactly as Codex expects", async () => {
    const { events, turn } = await startTurn();
    request(91, COMMAND, NETWORK_PARAMS);
    await waitFor(() => cards(events).length === 1, "card");
    expect(cards(events)[0].network?.host).toBe("registry.npmjs.org");
    respondCodexApproval(SESSION, cards(events)[0].requestId, "allow", {
      networkAmendment: { host: "registry.npmjs.org", action: "allow" },
    });
    expect(await answer(91)).toEqual({
      decision: {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: {
            host: "registry.npmjs.org",
            action: "allow",
          },
        },
      },
    });
    await finish(turn);
  });

  it("falls back to a plain accept for a host Codex did not propose", async () => {
    const { events, turn } = await startTurn();
    request(91, COMMAND, NETWORK_PARAMS);
    await waitFor(() => cards(events).length === 1, "card");
    respondCodexApproval(SESSION, cards(events)[0].requestId, "allow", {
      networkAmendment: { host: "evil.example", action: "allow" },
    });
    expect(await answer(91)).toEqual({ decision: "accept" });
    await finish(turn);
  });

  it("falls back to a plain accept when only a deny was proposed", async () => {
    const { events, turn } = await startTurn();
    request(91, COMMAND, {
      ...NETWORK_PARAMS,
      proposedNetworkPolicyAmendments: [
        { host: "registry.npmjs.org", action: "deny" },
      ],
    });
    await waitFor(() => cards(events).length === 1, "card");
    respondCodexApproval(SESSION, cards(events)[0].requestId, "allow", {
      networkAmendment: { host: "registry.npmjs.org", action: "allow" },
    });
    expect(await answer(91)).toEqual({ decision: "accept" });
    await finish(turn);
  });

  it("never sends an amendment with a deny", async () => {
    const { events, turn } = await startTurn();
    request(91, COMMAND, NETWORK_PARAMS);
    await waitFor(() => cards(events).length === 1, "card");
    respondCodexApproval(SESSION, cards(events)[0].requestId, "deny", {
      networkAmendment: { host: "registry.npmjs.org", action: "allow" },
    });
    expect(await answer(91)).toEqual({ decision: "decline" });
    await finish(turn);
  });

  it("resolves a blocked network approval instead of hanging (corner case 9)", async () => {
    const { events, turn } = await startTurn();
    request(91, COMMAND, NETWORK_PARAMS);
    await waitFor(() => cards(events).length === 1, "card");
    // The user blocks commands while the card is up: it is declined.
    setCodexToolAccess(SESSION, { never: ["codex:command"] });
    expect(await answer(91)).toEqual({ decision: "decline" });
    expect(
      events.some(
        (e) =>
          e.type === "approval.resolved" &&
          e.requestId === cards(events)[0].requestId,
      ),
    ).toBe(true);
    await finish(turn);
  });
});

describe("provider and permissions profile on the wire", () => {
  it("sends provider and profile on thread/start and the profile on turn/start", async () => {
    const { turn, fresh } = await startTurn({
      modelProvider: "ollama",
      permissionsProfile: "net-npm",
    });
    const thread = JSON.parse(
      JSON.stringify(fresh().find((m) => m.method === "thread/start")!.params),
    );
    expect(thread.modelProvider).toBe("ollama");
    expect(thread.permissions).toBe("net-npm");
    expect(thread).not.toHaveProperty("sandbox");
    expect(thread).not.toHaveProperty("sandboxPolicy");
    const turnParams = fresh().find((m) => m.method === "turn/start")!
      .params as Record<string, unknown>;
    expect(turnParams.permissions).toBe("net-npm");
    expect(turnParams).not.toHaveProperty("sandboxPolicy");
    expect(turnParams).not.toHaveProperty("modelProvider");
    await finish(turn);
  });

  it("never sends an id that fails the charset check", async () => {
    const { turn, fresh } = await startTurn({
      modelProvider: "$(rm -rf ~)",
      permissionsProfile: "../x",
    });
    const thread = fresh().find((m) => m.method === "thread/start")!
      .params as Record<string, unknown>;
    expect(thread).not.toHaveProperty("modelProvider");
    expect(thread).not.toHaveProperty("permissions");
    expect(thread).toHaveProperty("sandbox");
    await finish(turn);
  });

  it("reopens the thread when the provider or the profile changes", async () => {
    const opens = () =>
      parse().filter(
        (m) => m.method === "thread/start" || m.method === "thread/resume",
      );
    const first = await startTurn({ modelProvider: "ollama" });
    await finish(first.turn);
    expect(opens()).toHaveLength(1);

    // Same provider, no profile: the live thread is reused.
    const before = sent.length;
    const same = sendCodexTurn({
      sessionId: SESSION,
      cwd: "/repo",
      model: "codex:gpt-5.4",
      modelSettings: {},
      runtimeMode: "supervised",
      modelProvider: "ollama",
      text: "again",
      attachments: [],
      onEvent: () => undefined,
    });
    const reusedTurn = async () => {
      await waitFor(
        () =>
          sent
            .slice(before)
            .some(
              (l) =>
                (JSON.parse(l) as { method?: string }).method === "turn/start",
            ),
        "reused turn",
      );
      return sent
        .slice(before)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((m) => m.method === "turn/start")!;
    };
    reply((await reusedTurn()).id as number, {
      turn: { id: "turn_1", status: "inProgress" },
    });
    await finish(same);
    expect(opens()).toHaveLength(1);

    // A profile is added: the thread is opened again with it.
    const changed = await startTurnAnyOpen({
      modelProvider: "ollama",
      permissionsProfile: "net-npm",
    });
    await finish(changed.turn);
    expect(opens()).toHaveLength(2);
    expect(opens()[1].params).toMatchObject({ permissions: "net-npm" });

    // The provider changes: opened again.
    const provider = await startTurnAnyOpen({
      modelProvider: "lmstudio",
      permissionsProfile: "net-npm",
    });
    await finish(provider.turn);
    expect(opens()).toHaveLength(3);
    expect(opens()[2].params).toMatchObject({ modelProvider: "lmstudio" });
  });
});

/** A turn whose thread may be resumed rather than started. */
async function startTurnAnyOpen(options: {
  modelProvider?: string;
  permissionsProfile?: string;
}) {
  const before = sent.length;
  const turn = sendCodexTurn({
    sessionId: SESSION,
    cwd: "/repo",
    model: "codex:gpt-5.4",
    modelSettings: {},
    runtimeMode: "supervised",
    ...options,
    text: "again",
    attachments: [],
    onEvent: () => undefined,
  });
  const fresh = () =>
    sent.slice(before).map((l) => JSON.parse(l) as Record<string, unknown>);
  const done = new Set<unknown>();
  for (;;) {
    await waitFor(
      () => fresh().some((m) => m.method && m.id != null && !done.has(m.id)),
      "next request",
    );
    const msg = fresh().find(
      (m) => m.method && m.id != null && !done.has(m.id),
    )!;
    done.add(msg.id);
    if (msg.method === "turn/start") {
      reply(msg.id as number, { turn: { id: "turn_1", status: "inProgress" } });
      return { turn };
    }
    reply(
      msg.id as number,
      msg.method === "thread/start" || msg.method === "thread/resume"
        ? { thread: { id: "thr_1" } }
        : {},
    );
  }
}
