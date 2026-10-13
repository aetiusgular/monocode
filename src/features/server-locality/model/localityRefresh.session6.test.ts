import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    throw new Error(`unexpected ${command}`);
  }),
  isTauri: () => false,
}));

const installedMock = vi.hoisted(() => ({ connectors: [] as unknown[] }));
vi.mock("../../gateway-connectors/model/installed", async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import("../../gateway-connectors/model/installed")
    >();
  const state = () => ({
    connectors: installedMock.connectors,
    docker: "/usr/local/bin/docker",
    dockerState: "ready" as const,
    loading: false,
    at: 1,
    testing: [],
    signingIn: [],
    config: {},
  });
  return { ...real, installedState: state, useInstalledConnectors: state };
});

import {
  codexMcpServerList,
  codexModelRoute,
} from "../../../integrations/harness/providers/codex/codexProtocol";
import {
  isRelayedCloudModel,
  modelRoutePart,
  reportedRouteLocality,
  sessionLocalityNow,
} from "./locality";
import {
  HARNESS_REPORT_TTL_MS,
  __resetHarnessServers,
  registerHarnessConfigProbe,
} from "./sessionServers";
import { resetServerMarksCache } from "./serverMarks";

/**
 * Security fix F3: the route a Codex reported was read once per app run, an
 * Ollama `-cloud` model counted as local, and a profile's provider was
 * ignored.
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

const ollamaProvider = {
  name: "Ollama",
  base_url: "http://127.0.0.1:11434/v1",
  wire_api: "responses",
};
/** Codex 0.161.0's `config/read` for a wrapper home on a local Ollama. */
const localConfig = (model = "qwen2.5:7b") => ({
  config: {
    model,
    model_provider: "ollama_local",
    profile: null,
    profiles: {},
    model_providers: { ollama_local: ollamaProvider },
    mcp_servers: null,
  },
  origins: {},
});
/** The same home after it was edited to OpenRouter. */
const hostedConfig = {
  config: {
    model: "qwen/qwen3-coder",
    model_provider: "openrouter",
    profile: null,
    profiles: {},
    model_providers: {
      openrouter: {
        name: "OpenRouter",
        base_url: "https://openrouter.ai/api/v1",
      },
    },
    mcp_servers: null,
  },
  origins: {},
};

const CWD = "/Users/t/s7-gen";
const codexChat = {
  id: "c1",
  harness: "codex" as const,
  model: "codex:qwen2.5:7b",
  cwd: CWD,
  providerAccountId: "default",
};

let current: unknown;
function probeFrom() {
  const probe = vi.fn(async () => ({
    servers: codexMcpServerList(current) ?? [],
    route: codexModelRoute(current) ?? undefined,
  }));
  registerHarnessConfigProbe("codex", probe);
  return probe;
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
  });
  resetServerMarksCache();
  __resetHarnessServers();
  installedMock.connectors = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the reported route expires (F3.1)", () => {
  it("reads the home again after a minute, before local-only content", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T10:00:00Z"));
    current = localConfig();
    const probe = probeFrom();
    expect(await sessionLocalityNow(codexChat)).toBe("local");
    expect(probe).toHaveBeenCalledTimes(1);
    // Within the minute the answer stands.
    vi.setSystemTime(new Date("2026-10-13T10:00:30Z"));
    expect(await sessionLocalityNow(codexChat)).toBe("local");
    expect(probe).toHaveBeenCalledTimes(1);
    // The home is edited to OpenRouter; after the minute it is read again.
    current = hostedConfig;
    vi.setSystemTime(
      new Date(Date.parse("2026-10-13T10:00:00Z") + HARNESS_REPORT_TTL_MS + 1),
    );
    expect(await sessionLocalityNow(codexChat)).toBe("hosted");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("a failed read after the minute does not keep the old local answer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T10:00:00Z"));
    current = localConfig();
    probeFrom();
    expect(await sessionLocalityNow(codexChat)).toBe("local");
    registerHarnessConfigProbe("codex", async () => {
      throw new Error("Codex did not report its MCP servers in time");
    });
    vi.setSystemTime(new Date("2026-10-13T10:05:00Z"));
    expect(await sessionLocalityNow(codexChat)).toBe("unknown");
  });
});

describe("an Ollama cloud model is hosted (F3.2)", () => {
  it("names the -cloud and :cloud forms", () => {
    expect(isRelayedCloudModel("gpt-oss:120b-cloud")).toBe(true);
    expect(isRelayedCloudModel("qwen3-coder:480b-cloud")).toBe(true);
    expect(isRelayedCloudModel("deepseek-v3.1:671b-CLOUD")).toBe(true);
    expect(isRelayedCloudModel("kimi:cloud")).toBe(true);
    expect(isRelayedCloudModel("qwen2.5:7b")).toBe(false);
    expect(isRelayedCloudModel("cloudy:7b")).toBe(false);
    expect(isRelayedCloudModel(undefined)).toBe(false);
  });

  it("a loopback Ollama route with a cloud model is hosted", async () => {
    const route = codexModelRoute(localConfig("gpt-oss:120b-cloud"))!;
    expect(route.model).toBe("gpt-oss:120b-cloud");
    expect(reportedRouteLocality(route)).toBe("hosted");
    current = localConfig("gpt-oss:120b-cloud");
    probeFrom();
    expect(await sessionLocalityNow(codexChat)).toBe("hosted");
  });

  it("a chat whose own model is a cloud model is hosted on a local route", async () => {
    current = localConfig();
    probeFrom();
    const chat = { ...codexChat, model: "codex:gpt-oss:20b-cloud" };
    expect(await sessionLocalityNow(chat)).toBe("hosted");
    expect(modelRoutePart(chat).locality).toBe("hosted");
  });
});

describe("a profile in config/read (F3.3)", () => {
  const withProfile = (profiles: Record<string, unknown>, profile = "x") => ({
    config: {
      ...localConfig().config,
      profile,
      profiles,
      model_providers: {
        ...localConfig().config.model_providers,
        openrouter: {
          name: "OpenRouter",
          base_url: "https://openrouter.ai/api/v1",
        },
      },
    },
  });

  it("uses the profile's provider and model", () => {
    const route = codexModelRoute(
      withProfile({
        x: { model_provider: "openrouter", model: "qwen/qwen3-coder" },
      }),
    )!;
    expect(route.provider).toBe("openrouter");
    expect(route.model).toBe("qwen/qwen3-coder");
    expect(reportedRouteLocality(route)).toBe("hosted");
  });

  it("is unknown when the profile names no provider or is missing", () => {
    expect(codexModelRoute(withProfile({ x: { model: "m" } }))).toBeNull();
    expect(codexModelRoute(withProfile({}, "x"))).toBeNull();
    expect(codexModelRoute(withProfile({}, 7 as unknown as string))).toBeNull();
  });

  it("ignores profiles when none is chosen, as Codex 0.161.0 answers", () => {
    // Probed 13 Oct: `[profiles.x]` with no top-level profile gives
    // `profile: null` and the top-level route.
    const route = codexModelRoute(
      withProfile(
        { x: { model_provider: "openrouter" } },
        null as unknown as string,
      ),
    )!;
    expect(route.provider).toBe("ollama_local");
    expect(reportedRouteLocality(route)).toBe("local");
  });
});
