import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { provider, gateway } = vi.hoisted(() => ({
  provider: vi.fn((_id: string | undefined) => "unknown" as "local" | "hosted" | "unknown"),
  gateway: vi.fn(
    (
      _session: { harness: string; disabledMcpServers?: readonly string[] },
      _cwd: string,
    ) => ({
      servers: [] as { name: string; command: string; args: string[] }[],
      names: new Set<string>(),
      defaultOff: [] as string[],
    }),
  ),
}));
vi.mock("../../model-setup/model/providerLocality", () => ({
  providerLocality: provider,
}));
vi.mock("../../gateway-connectors/model/sessionGateway", () => ({
  gatewaySessionInput: gateway,
}));

import {
  combineLocality,
  harnessIsHosted,
  isLocal,
  sessionIsLocal,
  sessionLocalityParts,
} from "./locality";
import {
  describeServerLocality,
  isDockerGateway,
  isLoopbackUrl,
  localityExplanation,
  localityLabel,
  serverLocality,
} from "./serverLocality";
import {
  MAX_SERVER_MARKS,
  resetServerMarksCache,
  sanitizeServerMarks,
  sanitizeServerName,
  serverMark,
  SERVER_MARKS_KEY,
  setServerMark,
} from "./serverMarks";
import {
  __resetHarnessServers,
  knownHarnessServers,
  noteHarnessServers,
} from "./sessionServers";

function mockLocalStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      clear: () => data.clear(),
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() {
        return data.size;
      },
    },
    configurable: true,
  });
}

const GATEWAY = {
  name: "notion",
  command: "/usr/local/bin/docker",
  args: ["mcp", "gateway", "run", "--profile", "monocode_notion"],
};

beforeEach(() => {
  mockLocalStorage();
  resetServerMarksCache();
  __resetHarnessServers();
  provider.mockReset();
  provider.mockImplementation(() => "unknown");
  gateway.mockReset();
  gateway.mockImplementation(() => ({
    servers: [],
    names: new Set<string>(),
    defaultOff: [],
  }));
});
afterEach(() => {
  resetServerMarksCache();
});

describe("isLoopbackUrl", () => {
  it("names loopback hosts", () => {
    for (const url of [
      "http://localhost:3000/mcp",
      "http://127.0.0.1:8080",
      "https://127.4.5.6/",
      "http://[::1]:9000/sse",
      "ws://app.localhost/",
    ]) {
      expect(isLoopbackUrl(url)).toBe(true);
    }
  });

  it("refuses the userinfo trick that a prefix check lets through", () => {
    expect(isLoopbackUrl("http://localhost:@other.host/")).toBe(false);
    expect(isLoopbackUrl("http://127.0.0.1@evil.example/")).toBe(false);
    expect(isLoopbackUrl("http://localhost.evil.example/")).toBe(false);
  });

  it("calls a remote host remote and junk unknown", () => {
    expect(isLoopbackUrl("https://mcp.exa.ai/mcp")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBeUndefined();
    expect(isLoopbackUrl("file:///etc/passwd")).toBeUndefined();
    expect(isLoopbackUrl("")).toBeUndefined();
  });
});

describe("serverLocality", () => {
  it("calls a remote HTTP server hosted", () => {
    expect(serverLocality({ name: "exa", url: "https://mcp.exa.ai/mcp" })).toBe(
      "hosted",
    );
  });

  it("leaves a loopback server unknown until marked", () => {
    const server = { name: "dev", url: "http://localhost:4000/mcp" };
    expect(serverLocality(server)).toBe("unknown");
    expect(describeServerLocality(server).reason).toBe("loopback-address");
  });

  it("calls a Docker gateway entry hosted", () => {
    expect(isDockerGateway(GATEWAY)).toBe(true);
    expect(isDockerGateway({ name: "x", command: "docker", args: ["run", "x"] })).toBe(
      false,
    );
    expect(serverLocality(GATEWAY)).toBe("hosted");
  });

  it("calls a stdio proxy to a remote address hosted", () => {
    expect(
      serverLocality({
        name: "remote",
        command: "npx",
        args: ["-y", "mcp-remote", "https://api.example.com/mcp"],
      }),
    ).toBe("hosted");
  });

  it("leaves a plain stdio server unknown, since it may call out (gq-research)", () => {
    expect(serverLocality({ name: "gq-research", command: "uv", args: ["run", "server.py"] })).toBe(
      "unknown",
    );
  });

  it("lets your mark win, both ways", () => {
    setServerMark("playwright", "local");
    expect(serverLocality({ name: "playwright", command: "npx" })).toBe("local");
    setServerMark("notion", "local");
    expect(serverLocality(GATEWAY)).toBe("local");
    setServerMark("dev", "hosted");
    expect(serverLocality({ name: "dev", url: "http://localhost:4000" })).toBe("hosted");
    setServerMark("dev", undefined);
    expect(serverMark("dev")).toBeUndefined();
  });

  it("explains each result", () => {
    const result = describeServerLocality({ name: "x" });
    expect(localityLabel(result)).toBe("Not marked");
    expect(localityExplanation(result)).toMatch(/Counts as hosted/);
    expect(localityLabel({ locality: "local", reason: "your-mark" })).toBe("Local");
  });
});

describe("server marks storage", () => {
  it("survives a reload (case 14)", () => {
    setServerMark("ace-kg", "local");
    resetServerMarksCache();
    expect(serverMark("ace-kg")).toBe("local");
    expect(JSON.parse(localStorage.getItem(SERVER_MARKS_KEY) ?? "{}")).toEqual({
      "ace-kg": "local",
    });
  });

  it("drops bad names and values from storage", () => {
    localStorage.setItem(
      SERVER_MARKS_KEY,
      JSON.stringify({ ok: "local", bad: "maybe", "": "local", "a\nb": "hosted", __proto__: "local" }),
    );
    resetServerMarksCache();
    expect(serverMark("ok")).toBe("local");
    expect(serverMark("bad")).toBeUndefined();
    expect(sanitizeServerName("__proto__")).toBeUndefined();
    expect(sanitizeServerName("x".repeat(201))).toBeUndefined();
  });

  it("ignores corrupt storage", () => {
    localStorage.setItem(SERVER_MARKS_KEY, "{not json");
    resetServerMarksCache();
    expect(serverMark("anything")).toBeUndefined();
    setServerMark("after", "hosted");
    expect(serverMark("after")).toBe("hosted");
  });

  it("caps the number of marks", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < MAX_SERVER_MARKS + 50; i += 1) many[`s${i}`] = "local";
    expect(Object.keys(sanitizeServerMarks(many))).toHaveLength(MAX_SERVER_MARKS);
  });
});

describe("sessionIsLocal", () => {
  const localCodex = {
    harness: "codex" as const,
    cwd: "/repo",
    providerAccountId: "local",
    modelProvider: "ollama_local",
  };

  it("calls hosted-only harnesses hosted", () => {
    for (const harness of ["claude", "cursor", "grok", "antigravity", "devin"] as const) {
      expect(harnessIsHosted(harness)).toBe(true);
      expect(sessionIsLocal({ harness })).toBe("hosted");
    }
    expect(harnessIsHosted("codex")).toBe(false);
  });

  it("is local only with a local route and every tool local", () => {
    provider.mockImplementation(() => "local");
    expect(sessionIsLocal(localCodex, [])).toBe("local");
    expect(isLocal(sessionIsLocal(localCodex, []))).toBe(true);
  });

  it("is unknown while the harness's own servers were never reported", () => {
    provider.mockImplementation(() => "local");
    expect(sessionIsLocal(localCodex)).toBe("unknown");
  });

  it("uses the servers the harness last reported", () => {
    provider.mockImplementation(() => "local");
    noteHarnessServers("codex", "local", "/repo", []);
    expect(sessionIsLocal(localCodex)).toBe("local");
    noteHarnessServers("codex", "local", "/repo", [
      { name: "exa", enabled: true, url: "https://mcp.exa.ai/mcp" },
    ]);
    expect(sessionIsLocal(localCodex)).toBe("hosted");
    noteHarnessServers("codex", "local", "/repo", undefined);
    expect(knownHarnessServers("codex", "local", "/repo")).toBeUndefined();
  });

  it("ignores servers the harness reports switched off in its config", () => {
    provider.mockImplementation(() => "local");
    noteHarnessServers("codex", "local", "/repo", [
      { name: "exa", enabled: false, url: "https://mcp.exa.ai/mcp" },
    ]);
    expect(sessionIsLocal(localCodex)).toBe("local");
  });

  it("turns hosted when a hosted connector is on in a local session (case 8)", () => {
    provider.mockImplementation(() => "local");
    gateway.mockImplementation(() => ({
      servers: [GATEWAY],
      names: new Set(["notion"]),
      defaultOff: [],
    }));
    expect(sessionIsLocal(localCodex, [])).toBe("hosted");
    const parts = sessionLocalityParts(localCodex, []);
    expect(parts.map((part) => [part.label, part.locality])).toEqual([
      ["ollama_local", "local"],
      ["notion", "hosted"],
    ]);
  });

  it("passes the chat's switches to the gateway", () => {
    provider.mockImplementation(() => "local");
    sessionIsLocal({ ...localCodex, disabledMcpServers: ["notion"] }, []);
    expect(gateway).toHaveBeenCalledWith(
      expect.objectContaining({ disabledMcpServers: ["notion"] }),
      "/repo",
    );
  });

  it("skips a switched-off own server", () => {
    provider.mockImplementation(() => "local");
    expect(
      sessionIsLocal({ ...localCodex, disabledMcpServers: ["exa"] }, [
        { name: "exa", url: "https://mcp.exa.ai/mcp" },
      ]),
    ).toBe("local");
  });

  it("is unknown when the model route is unknown, hosted when it is hosted", () => {
    expect(sessionIsLocal(localCodex, [])).toBe("unknown");
    provider.mockImplementation(() => "hosted");
    expect(sessionIsLocal(localCodex, [])).toBe("hosted");
  });

  it("reads the worktree folder for reported servers", () => {
    provider.mockImplementation(() => "local");
    noteHarnessServers("codex", "local", "/repo-wt", []);
    expect(sessionIsLocal({ ...localCodex, worktreeCwd: "/repo-wt" })).toBe("local");
  });

  it("is unknown, never local, when the gateway cannot be read", () => {
    provider.mockImplementation(() => "local");
    gateway.mockImplementation(() => {
      throw new Error("no docker");
    });
    expect(sessionIsLocal(localCodex, [])).toBe("unknown");
  });

  it("combines hosted over unknown over local", () => {
    expect(combineLocality(["local", "unknown"])).toBe("unknown");
    expect(combineLocality(["unknown", "hosted", "local"])).toBe("hosted");
    expect(combineLocality([])).toBe("local");
  });
});
