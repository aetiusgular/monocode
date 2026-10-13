import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;
vi.mock("../../core/child", () => ({
  resolveCodexBinary: async () => ({ path: "/fake/codex" }),
  spawnChild: async () => undefined,
  restoreMonoCodexAgentState: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  acquireHarnessBridge: async () => () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
}));

const { sendCodexTurn, stopCodexSession, __codexTestReset } =
  await import("./codex");
import { codexRouteLocality, codexWebSearchConfig } from "./codexProviders";
import { buildThreadStartParams } from "./codexProtocol";
import { saveModelProvider } from "../../../../features/model-setup/model/modelProviders";
import {
  __resetHarnessServers,
  registerHarnessConfigProbe,
} from "../../../../features/server-locality/model/sessionServers";
import {
  canResearch,
  researchRequest,
  researchTools,
} from "../../../../features/research-mode/model/searchTools";
import { researchTurnPrompt } from "../../../../features/research-mode/model/researchPrompt";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

const parse = () =>
  sent.map((line) => JSON.parse(line) as Record<string, unknown>);
const find = (method: string) => parse().find((m) => m.method === method);
const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

/** Opens a thread for a chat and returns the thread/start params. */
async function threadStartParams(input: {
  modelProvider?: string;
  providerAccountId?: string;
}): Promise<Record<string, unknown>> {
  const turn = sendCodexTurn({
    sessionId: "ws",
    cwd: "/Users/me/my repo",
    model: "codex:qwen2.5-coder:7b",
    modelSettings: {},
    runtimeMode: "supervised",
    text: "what is new",
    attachments: [],
    onEvent: () => undefined,
    ...input,
  });
  await waitFor(() => !!find("initialize"), "initialize");
  onLine!(JSON.stringify({ id: find("initialize")!.id, result: {} }));
  await waitFor(() => !!find("thread/start"), "thread/start");
  const params = find("thread/start")!.params as Record<string, unknown>;
  onLine!(
    JSON.stringify({
      id: find("thread/start")!.id,
      result: { thread: { id: "thr_1" } },
    }),
  );
  await waitFor(() => !!find("turn/start"), "turn/start");
  onLine!(
    JSON.stringify({
      id: find("turn/start")!.id,
      result: { turn: { id: "turn_1", status: "inProgress" } },
    }),
  );
  onLine!(
    JSON.stringify({
      method: "turn/completed",
      params: { turn: { id: "turn_1", status: "completed" } },
    }),
  );
  await turn;
  return params;
}

beforeEach(() => {
  sent.length = 0;
  onLine = undefined;
  vi.stubGlobal("localStorage", memoryStorage());
  __resetHarnessServers();
});
afterEach(async () => {
  await stopCodexSession("ws");
  __codexTestReset();
  __resetHarnessServers();
  vi.unstubAllGlobals();
});

describe("Mac fix 11.15: Codex web search off on a local model route", () => {
  it("uses the key Codex 0.161.0 honours", () => {
    expect(codexWebSearchConfig("local")).toEqual({ web_search: "disabled" });
    expect(codexWebSearchConfig("hosted")).toBeUndefined();
    expect(codexWebSearchConfig("unknown")).toBeUndefined();
    const params = buildThreadStartParams({
      cwd: "/x",
      runtimeMode: "supervised",
      providerConfig: { web_search: "disabled" },
    });
    expect(params.config).toEqual({ web_search: "disabled" });
  });

  it("judges the route by the chat's provider, its account, then what Codex reported", () => {
    saveModelProvider({
      id: "ollama_local",
      label: "Ollama",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      accountId: "acct-ollama",
    });
    expect(codexRouteLocality({ modelProvider: "ollama_local" })).toBe("local");
    expect(codexRouteLocality({ providerAccountId: "acct-ollama" })).toBe(
      "local",
    );
    expect(codexRouteLocality({ modelProvider: "openai" })).toBe("hosted");
    expect(codexRouteLocality({})).toBe("unknown");
    // The wrapper script home: its own config names Ollama on loopback.
    expect(
      codexRouteLocality({
        reported: {
          provider: "wrapper_ollama",
          baseUrls: { wrapper_ollama: "http://localhost:11434/v1" },
        },
      }),
    ).toBe("local");
    expect(
      codexRouteLocality({
        reported: { provider: "openai", baseUrls: {} },
      }),
    ).toBe("hosted");
  });

  it("sends web_search disabled on thread/start for a local provider", async () => {
    saveModelProvider({
      id: "ollama_local",
      label: "Ollama",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      accountId: "acct-ollama",
    });
    const params = await threadStartParams({ modelProvider: "ollama_local" });
    expect(params.config).toMatchObject({ web_search: "disabled" });
  });

  it("sends it for a wrapper home whose own config routes to loopback", async () => {
    registerHarnessConfigProbe("codex", async () => ({
      servers: [],
      route: {
        provider: "ollama_wrapper",
        baseUrls: { ollama_wrapper: "http://127.0.0.1:11434/v1" },
      },
    }));
    const params = await threadStartParams({});
    expect(params.config).toMatchObject({ web_search: "disabled" });
  });

  it("leaves a hosted or unknown route alone", async () => {
    const params = await threadStartParams({});
    expect(params.config).toBeUndefined();
    await stopCodexSession("ws");
    __codexTestReset();
    sent.length = 0;
    registerHarnessConfigProbe("codex", async () => ({
      servers: [],
      route: { provider: "openai", baseUrls: {} },
    }));
    const hosted = await threadStartParams({});
    expect(hosted.config).toBeUndefined();
  });
});

describe("Mac fix 11.15: research on a local Codex chat", () => {
  it("still works through a connector and never names web_search", () => {
    const tools = researchTools({
      harness: "codex",
      gateway: [{ sessionName: "exa", title: "Exa", server: "exa" }],
    });
    expect(canResearch(tools)).toBe(true);
    const request = researchRequest(
      tools,
      { harness: "codex" },
      "research/2026-10-13-q.md",
    )!;
    const prompt = researchTurnPrompt("What changed in Ollama 0.12?", request);
    expect(prompt).toContain("the exa connector");
    expect(prompt).not.toMatch(/\bweb_search\b(?!_exa)/);
    expect(prompt).not.toContain("WebSearch");
  });

  it("offers no research with Codex's own web search only", () => {
    expect(canResearch(researchTools({ harness: "codex" }))).toBe(false);
  });
});
