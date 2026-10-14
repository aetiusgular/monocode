import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
  isTauri: () => false,
}));

import {
  codexMcpServerList,
  codexModelRoute,
} from "../../../integrations/harness/providers/codex/codexProtocol";
import { newSession, type Session } from "../../sessions/model/session";
import { saveModelProvider } from "../../model-setup/model/modelProviders";
import { providerLocality } from "../../model-setup/model/providerLocality";
import { privacyView } from "../../privacy-view/model/privacyView";
import {
  HARNESS_REPORT_TTL_MS,
  __resetHarnessServers,
  registerHarnessConfigProbe,
} from "../../server-locality/model/sessionServers";
import { modelRouteLocalityNow } from "../../server-locality/model/locality";
import { inlineMentionSource } from "./promptPreparation";

/**
 * Mac finding 3.13, third pass. On the wrapper-home Codex (corner case 13)
 * `@calc.py` was not inlined: the gate read the chat's provider from the
 * Models page, where the wrapper's `ollama_local` is not listed, so it was
 * unknown. The gate now judges the model route the way the privacy panel's
 * model row does, after asking the harness.
 */

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

const route = (provider: string, baseUrl: string, model = "qwen2.5:7b") => ({
  config: {
    model,
    model_provider: provider,
    model_providers: { [provider]: { base_url: baseUrl } },
    mcp_servers: null,
    profile: null,
  },
});
const WRAPPER = route("ollama_local", "http://127.0.0.1:11434/v1");
const HOSTED = route("openrouter", "https://openrouter.ai/api/v1");

function probeAnswering(result: unknown) {
  const probe = vi.fn(async () => ({
    servers: codexMcpServerList(result) ?? [],
    route: codexModelRoute(result) ?? undefined,
  }));
  registerHarnessConfigProbe("codex", probe);
  return probe;
}

const CWD = "/Users/t/s7-gen";
const TYPED = "quote the names of the functions defined in @calc.py";
const NOW = new Date("2026-10-13T12:00:00Z");

function chat(over: Partial<Session> = {}): Session {
  return {
    ...newSession("codex", CWD, "codex:qwen2.5:7b"),
    id: "local-1",
    providerAccountId: "default",
    ...over,
  };
}

const panelRow = (session: Session) =>
  privacyView({ ...session, blocks: [] }).destinations[0];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
  });
  __resetHarnessServers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("3.13: the inline gate reads the model route as the panel does", () => {
  it("a wrapper home on loopback inlines, though the Models page does not list it", async () => {
    const probe = probeAnswering(WRAPPER);
    const session = chat();
    // The old gate's reading.
    expect(providerLocality(session.modelProvider)).toBe("unknown");
    expect(await inlineMentionSource(TYPED, session)).toEqual({
      typed: TYPED,
      local: true,
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(panelRow(session)).toMatchObject({
      detail: "ollama_local (127.0.0.1:11434), from the harness's own config",
      locality: "local",
    });
  });

  it("a hosted home inlines nothing", async () => {
    probeAnswering(HOSTED);
    expect((await inlineMentionSource(TYPED, chat())).local).toBe(false);
  });

  it("an Ollama cloud model through the local Ollama inlines nothing", async () => {
    probeAnswering(
      route("ollama_local", "http://127.0.0.1:11434/v1", "gpt-oss:120b-cloud"),
    );
    expect((await inlineMentionSource(TYPED, chat())).local).toBe(false);
  });

  it("no report (a failed or slow probe) inlines nothing", async () => {
    registerHarnessConfigProbe("codex", async () => {
      throw new Error("Codex did not report its MCP servers in time");
    });
    expect((await inlineMentionSource(TYPED, chat())).local).toBe(false);
  });

  it("a report older than a minute is read again; a home edited to hosted inlines nothing", async () => {
    probeAnswering(WRAPPER);
    expect((await inlineMentionSource(TYPED, chat())).local).toBe(true);
    vi.setSystemTime(new Date(NOW.getTime() + HARNESS_REPORT_TTL_MS + 1));
    probeAnswering(HOSTED);
    expect((await inlineMentionSource(TYPED, chat())).local).toBe(false);
  });

  it("a stale local report that cannot be read again counts as unknown", async () => {
    probeAnswering(WRAPPER);
    await modelRouteLocalityNow(chat());
    vi.setSystemTime(new Date(NOW.getTime() + HARNESS_REPORT_TTL_MS + 1));
    registerHarnessConfigProbe("codex", async () => null);
    expect(await modelRouteLocalityNow(chat())).toBe("unknown");
  });

  it("a provider picked for the chat decides without asking the harness", async () => {
    const probe = probeAnswering(HOSTED);
    saveModelProvider({
      id: "lmstudio_mac",
      label: "LM Studio",
      kind: "lmstudio",
      baseUrl: "http://localhost:1234/v1",
    });
    expect(
      (
        await inlineMentionSource(
          TYPED,
          chat({ modelProvider: "lmstudio_mac" }),
        )
      ).local,
    ).toBe(true);
    expect(
      (await inlineMentionSource(TYPED, chat({ modelProvider: "openai" })))
        .local,
    ).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("a hosted connector does not stop inlining on a local route, as the panel's model row says", async () => {
    // The gate is the model route only; a connector does not receive the
    // prompt text from MonoCode.
    probeAnswering(WRAPPER);
    expect(
      await modelRouteLocalityNow(chat({ gatewayOn: ["exa-remote"] })),
    ).toBe("local");
  });

  it("Claude Code is hosted and never asked; text with no mention asks nothing", async () => {
    const probe = probeAnswering(WRAPPER);
    const claude = { ...newSession("claude", CWD), id: "c1" };
    expect((await inlineMentionSource(TYPED, claude)).local).toBe(false);
    expect(await modelRouteLocalityNow(claude)).toBe("hosted");
    expect(await inlineMentionSource("no mention here", chat())).toEqual({
      typed: "no mention here",
      local: false,
    });
    expect(await inlineMentionSource("", chat())).toEqual({
      typed: "",
      local: false,
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("a worktree chat reads the route reported for its worktree", async () => {
    const probe = probeAnswering(WRAPPER);
    const wt = chat({ worktreeCwd: `${CWD}/.wt/a` });
    expect((await inlineMentionSource(TYPED, wt)).local).toBe(true);
    expect(probe).toHaveBeenCalledWith({
      cwd: `${CWD}/.wt/a`,
      providerAccountId: "default",
    });
  });
});
