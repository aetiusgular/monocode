import { beforeEach, describe, expect, it, vi } from "vitest";

// The real Codex and Claude Code CLIs are not run here; project files are.
const files = new Map<string, string>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "project_context_read") {
      const key = `${args.scope}:${args.project ?? ""}:${args.file}`;
      const text = files.get(key) ?? null;
      return { text, hash: `h${(text ?? "").length}` };
    }
    if (command === "session_preamble_write") return "/data/preamble.md";
    throw new Error(`unexpected ${command}`);
  }),
  isTauri: () => false,
}));

import {
  codexModelRoute,
  codexMcpServerList,
} from "../../../integrations/harness/providers/codex/codexProtocol";
import {
  isLocal,
  modelRoutePart,
  reportedRouteLocality,
  sessionIsLocal,
  sessionLocalityNow,
} from "./locality";
import {
  __resetHarnessServers,
  knownHarnessModelRoute,
  noteHarnessModelRoute,
  noteHarnessServers,
  registerHarnessConfigProbe,
} from "./sessionServers";
import {
  connectorLocalityServer,
  describeServerLocality,
  gatewayLocalityServer,
  localityExplanation,
  localityLabel,
  localityMarkable,
  serverLocality,
} from "./serverLocality";
import { resetServerMarksCache, setServerMark } from "./serverMarks";
import { connectorKindDetail } from "../../gateway-connectors/model/connectorRows";
import { trimCatalogEntry } from "../../gateway-connectors/model/catalog";
import type { InstalledConnector } from "../../gateway-connectors/model/installed";
import { prepareSessionPreamble } from "../../session-preamble/model/sessionPreamble";
import { handleProjectMemory } from "../../project-memory/model/agentMemory";
import { privacyView } from "../../privacy-view/model/privacyView";
import { saveModelProvider } from "../../model-setup/model/modelProviders";

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

/**
 * What Codex 0.161.0's `config/read` returned on 13 Oct for a home whose
 * config.toml names `model_provider = "ollama_local"` (the wrapper home in
 * Mac finding 5.6), trimmed to the keys read here. Probed with
 * `codex app-server` under a temporary CODEX_HOME.
 */
const CONFIG_READ_OLLAMA = {
  config: {
    model: "qwen2.5:7b",
    model_provider: "ollama_local",
    model_providers: {
      ollama_local: {
        name: "Ollama",
        base_url: "http://127.0.0.1:11434/v1",
        model_catalog_url: null,
        env_key: null,
        experimental_bearer_token: null,
        auth: null,
        wire_api: "responses",
        query_params: null,
        http_headers: null,
        requires_openai_auth: false,
        supports_websockets: false,
      },
    },
    mcp_servers: {
      files: {
        command: "npx",
        args: ["-y", "fs-server"],
        environment_id: "local",
        enabled: false,
        tool_timeout_sec: null,
      },
    },
    oss_provider: null,
  },
  origins: {
    model_provider: {
      name: {
        type: "user",
        file: "/Users/t/codex-local-test/config.toml",
        profile: null,
      },
      version: "sha256:905c",
    },
  },
};
/** A home with no provider set: Codex answers `model_provider: null`. */
const CONFIG_READ_DEFAULT = {
  config: {
    model: "x",
    model_provider: null,
    model_providers: {},
    mcp_servers: null,
  },
  origins: {},
};

const CWD = "/Users/t/s7-gen";
const PROJECT = CWD;
const localCodex = {
  id: "codex-local",
  harness: "codex" as const,
  model: "codex:qwen2.5:7b",
  cwd: CWD,
  providerAccountId: "default",
};

/** The wrapper home's answer, through the registered probe as at run time. */
function wrapperProbe() {
  const probe = vi.fn(async () => ({
    servers: codexMcpServerList(CONFIG_READ_OLLAMA) ?? [],
    route: codexModelRoute(CONFIG_READ_OLLAMA) ?? undefined,
  }));
  registerHarnessConfigProbe("codex", probe);
  return probe;
}

const timeConnector: InstalledConnector = {
  profileId: "monocode_time",
  server: "time",
  title: "Time",
  description: "",
  kind: "container",
  image: "mcp/time",
  auth: "none",
  sessionName: "time",
  secrets: [],
  missingSecrets: [],
  settings: [],
  missingSettings: [],
  setup: "complete",
  status: "ready",
};
const dotnet: InstalledConnector = {
  ...timeConnector,
  profileId: "monocode_dotnet-types-explorer",
  server: "dotnet-types-explorer",
  title: ".NET types",
  image: "mcp/dotnet-types-explorer",
  sessionName: "dotnet-types-explorer",
};
const shopify: InstalledConnector = {
  ...timeConnector,
  profileId: "monocode_shopify-remote",
  server: "shopify-remote",
  title: "Shopify",
  kind: "remote",
  image: undefined,
  auth: "oauth",
  sessionName: "shopify-remote",
};

const installedMock = vi.hoisted(() => ({
  connectors: [] as InstalledConnector[],
}));
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

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
  });
  resetServerMarksCache();
  __resetHarnessServers();
  installedMock.connectors = [];
  files.clear();
  files.set(
    `project:${PROJECT}:MEMORY.md`,
    "- 2026-10-01 · Tests run with npm run check\n- 2026-10-02 · [local] The client is United\n",
  );
});

describe("5.6: the route a wrapper-home Codex reports", () => {
  it("reads the provider and base URL from Codex 0.161.0's config/read", () => {
    // Security fix F3: the route also carries the configured model.
    expect(codexModelRoute(CONFIG_READ_OLLAMA)).toEqual({
      provider: "ollama_local",
      baseUrls: { ollama_local: "http://127.0.0.1:11434/v1" },
      model: "qwen2.5:7b",
    });
    expect(codexModelRoute(CONFIG_READ_DEFAULT)).toEqual({
      provider: "openai",
      baseUrls: {},
      model: "x",
    });
    expect(codexModelRoute({})).toBeNull();
    expect(codexModelRoute({ config: { model_provider: 3 } })).toBeNull();
  });

  it("calls a loopback base URL local and anything else hosted, by the URL parser", () => {
    const at = (url: string) =>
      reportedRouteLocality({ provider: "p", baseUrls: { p: url } });
    expect(at("http://127.0.0.1:11434/v1")).toBe("local");
    expect(at("http://127.1.2.3:8080/v1")).toBe("local");
    expect(at("http://localhost:1234/v1")).toBe("local");
    expect(at("http://[::1]:11434/v1")).toBe("local");
    // The userinfo trick, a look-alike host, and a LAN box are not this Mac.
    expect(at("http://localhost:@evil.example/v1")).toBe("hosted");
    expect(at("http://user:pw@127.0.0.1/v1")).toBe("hosted");
    expect(at("http://localhost.evil.example/v1")).toBe("hosted");
    expect(at("http://192.168.1.20:11434/v1")).toBe("hosted");
    expect(reportedRouteLocality({ provider: "openai", baseUrls: {} })).toBe(
      "hosted",
    );
    expect(reportedRouteLocality({ provider: "custom", baseUrls: {} })).toBe(
      "unknown",
    );
  });

  it("a rented GPU behind an SSH tunnel on loopback stays hosted", () => {
    saveModelProvider({
      id: "rented_box",
      label: "Rented",
      kind: "rented",
      baseUrl: "http://127.0.0.1:8000/v1",
    });
    expect(
      reportedRouteLocality({
        provider: "rented_box",
        baseUrls: { rented_box: "http://127.0.0.1:8000/v1" },
      }),
    ).toBe("hosted");
  });

  it("keeps unknown as hosted until the harness reports", () => {
    expect(modelRoutePart(localCodex).locality).toBe("unknown");
    noteHarnessModelRoute(
      "codex",
      "default",
      CWD,
      codexModelRoute(CONFIG_READ_OLLAMA)!,
    );
    expect(modelRoutePart(localCodex)).toEqual({
      label: "ollama_local",
      kind: "model",
      locality: "local",
    });
    // A session with no account recorded uses the default account's report.
    expect(
      modelRoutePart({ ...localCodex, providerAccountId: undefined }).locality,
    ).toBe("local");
  });

  it("a provider picked for the chat wins over the home's config", () => {
    noteHarnessModelRoute(
      "codex",
      "default",
      CWD,
      codexModelRoute(CONFIG_READ_OLLAMA)!,
    );
    expect(
      modelRoutePart({ ...localCodex, modelProvider: "openai" }).locality,
    ).toBe("hosted");
  });

  it("names the reported provider in Where data goes", () => {
    noteHarnessModelRoute(
      "codex",
      "default",
      CWD,
      codexModelRoute(CONFIG_READ_OLLAMA)!,
    );
    noteHarnessServers("codex", "default", CWD, []);
    const view = privacyView({
      ...localCodex,
      runtimeMode: "auto",
      blocks: [],
    });
    expect(view.destinations[0]).toMatchObject({
      kind: "model",
      locality: "local",
      detail: "ollama_local (127.0.0.1:11434), from the harness's own config",
    });
  });
});

describe("2.23: local-only memory reaches a local Codex chat", () => {
  it("a local Codex chat with connectors off gets local-only entries", async () => {
    const probe = wrapperProbe();
    const prepared = await prepareSessionPreamble({
      session: { ...localCodex, providerSessionId: undefined },
      project: PROJECT,
      commandFirst: false,
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(prepared.developerInstructions).toContain("The client is United");
    expect(prepared.developerInstructions).toContain(
      "Tests run with npm run check",
    );
    expect(knownHarnessModelRoute("codex", "default", CWD)?.provider).toBe(
      "ollama_local",
    );
  });

  it("MonoCode's own outbound calls do not make the chat non-local", async () => {
    wrapperProbe();
    expect(isLocal(await sessionLocalityNow(localCodex))).toBe(true);
    const view = privacyView(
      { ...localCodex, runtimeMode: "auto", blocks: [] },
      { outboundOn: () => true },
    );
    // Listed, as MonoCode's own, and still private.
    expect(
      view.destinations.filter((item) => item.kind === "monocode").length,
    ).toBeGreaterThanOrEqual(4);
    expect(view.private).toBe(true);
  });

  it("with a hosted connector on, local-only entries are kept out", async () => {
    wrapperProbe();
    installedMock.connectors = [shopify];
    const prepared = await prepareSessionPreamble({
      session: localCodex,
      project: PROJECT,
      commandFirst: false,
    });
    expect(prepared.developerInstructions).toContain(
      "Tests run with npm run check",
    );
    expect(prepared.developerInstructions).not.toContain("United");
    // Switched off for this chat, it no longer counts.
    const off = { ...localCodex, disabledMcpServers: ["shopify-remote"] };
    expect(sessionIsLocal(off)).toBe("local");
  });

  it("a Docker container that may reach the network keeps them out too", async () => {
    wrapperProbe();
    installedMock.connectors = [dotnet];
    await sessionLocalityNow(localCodex);
    expect(sessionIsLocal(localCodex)).toBe("unknown");
    installedMock.connectors = [timeConnector];
    expect(sessionIsLocal(localCodex)).toBe("local");
  });

  it("a probe that fails leaves the chat unknown, and local-only entries out", async () => {
    registerHarnessConfigProbe("codex", async () => {
      throw new Error("Codex did not report its MCP servers in time");
    });
    const prepared = await prepareSessionPreamble({
      session: localCodex,
      project: PROJECT,
      commandFirst: false,
    });
    expect(prepared.developerInstructions).not.toContain("United");
  });

  it("Claude Code never gets them, and is never probed", async () => {
    const probe = vi.fn(async () => null);
    registerHarnessConfigProbe("claude", probe);
    const claude = {
      id: "c1",
      harness: "claude" as const,
      model: "claude:sonnet-5",
      cwd: CWD,
    };
    expect(await sessionLocalityNow(claude)).toBe("hosted");
    expect(probe).not.toHaveBeenCalled();
    const answer = (await handleProjectMemory(claude, "memory.read", {})) as {
      entries: { fact: string }[];
    };
    expect(answer.entries.map((entry) => entry.fact)).toEqual([
      "Tests run with npm run check",
    ]);
  });

  it("the app CLI's memory.read gives a local Codex chat both entries", async () => {
    wrapperProbe();
    const answer = (await handleProjectMemory(
      localCodex,
      "memory.read",
      {},
    )) as {
      entries: { fact: string }[];
    };
    expect(answer.entries.map((entry) => entry.fact)).toEqual([
      "Tests run with npm run check",
      "The client is United",
    ]);
  });
});

describe("12.8: connector locality marks", () => {
  it("a remote connector is hosted, and your local mark cannot change that", () => {
    const server = gatewayLocalityServer(shopify);
    expect(serverLocality(server)).toBe("hosted");
    setServerMark("shopify-remote", "local");
    const result = describeServerLocality(server);
    expect(result).toEqual({ locality: "hosted", reason: "remote-connector" });
    expect(localityMarkable(result)).toBe(false);
  });

  it("time is local; another container may reach the network", () => {
    expect(
      describeServerLocality(gatewayLocalityServer(timeConnector)),
    ).toEqual({
      locality: "local",
      reason: "known-local",
    });
    const other = describeServerLocality(gatewayLocalityServer(dotnet));
    expect(other).toEqual({ locality: "unknown", reason: "docker-container" });
    expect(localityLabel(other)).toBe("May reach network");
    expect(localityExplanation(other)).toMatch(
      /Runs in Docker, may reach the network/,
    );
    // A look-alike image named time is not the known one.
    expect(
      serverLocality(
        gatewayLocalityServer({ ...timeConnector, image: "someone/time" }),
      ),
    ).toBe("unknown");
  });

  it("a container the catalog runs with no network is local", () => {
    const entry = trimCatalogEntry({
      name: "sequentialthinking",
      type: "server",
      image: "mcp/sequentialthinking",
      disableNetwork: true,
    });
    expect(entry?.noNetwork).toBe(true);
    expect(
      serverLocality(gatewayLocalityServer({ ...dotnet, noNetwork: true })),
    ).toBe("local");
    // A remote entry never carries the flag.
    expect(
      trimCatalogEntry({
        name: "x-remote",
        type: "remote",
        remote: { url: "https://x.example/mcp" },
        disableNetwork: true,
      })?.noNetwork,
    ).toBeUndefined();
  });

  it("the row detail says where it runs", () => {
    expect(connectorKindDetail(shopify)).toBe("Hosted");
    expect(connectorKindDetail(timeConnector)).toBe(
      "Runs in Docker, no network",
    );
    expect(connectorKindDetail(dotnet)).toBe(
      "Runs in Docker, may reach the network",
    );
  });

  it("the composer row and the session use one rule, before and during a turn", () => {
    installedMock.connectors = [shopify, timeConnector];
    // While a turn runs the harness's live list names shopify-remote with
    // the gateway command and no catalog facts; idle, the list may not have
    // it at all. Both read the added connector's facts.
    const live = connectorLocalityServer("shopify-remote", {
      command: "/usr/local/bin/docker",
      args: ["mcp", "gateway", "run", "--profile", "monocode_shopify-remote"],
    });
    const idle = connectorLocalityServer("shopify-remote");
    expect(serverLocality(live)).toBe("hosted");
    expect(serverLocality(idle)).toBe("hosted");
    // A bare docker entry from the harness, found by name.
    expect(
      serverLocality({
        name: "time",
        command: "docker",
        args: ["mcp", "gateway", "run"],
      }),
    ).toBe("local");
    expect(serverLocality({ name: "shopify-remote", command: "docker" })).toBe(
      "hosted",
    );
  });
});

describe("5.4: the Private reason names what ended it", () => {
  it("names the hosted connector", async () => {
    wrapperProbe();
    installedMock.connectors = [shopify];
    await sessionLocalityNow(localCodex);
    const view = privacyView(
      { ...localCodex, runtimeMode: "auto", blocks: [] },
      {
        gatewayServers: [
          {
            name: "shopify-remote",
            command: "/usr/local/bin/docker",
            args: [
              "mcp",
              "gateway",
              "run",
              "--profile",
              "monocode_shopify-remote",
            ],
          },
        ],
      },
    );
    expect(view.private).toBe(false);
    expect(view.notPrivateBecause).toBe("shopify-remote is hosted");
  });

  it("names a hosted connector even while the model route is still unknown", () => {
    installedMock.connectors = [shopify];
    const view = privacyView(
      { ...localCodex, runtimeMode: "auto", blocks: [] },
      {
        gatewayServers: [
          {
            name: "shopify-remote",
            command: "docker",
            args: [
              "mcp",
              "gateway",
              "run",
              "--profile",
              "monocode_shopify-remote",
            ],
          },
        ],
      },
    );
    expect(view.notPrivateBecause).toBe("shopify-remote is hosted");
  });
});
