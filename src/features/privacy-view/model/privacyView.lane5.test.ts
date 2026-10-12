import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const localityMock = vi.hoisted(() => ({
  session: "unknown" as string,
  server: "unknown" as string,
}));
vi.mock("../../server-locality/model/locality", async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import("../../server-locality/model/locality")
    >();
  return { ...real, sessionIsLocal: () => localityMock.session };
});
vi.mock("../../server-locality/model/serverLocality", () => ({
  serverLocality: () => localityMock.server,
}));

import {
  networkLog,
  privacyView,
  sandboxView,
  type PrivacySession,
} from "./privacyView";
import { PrivacySection } from "../ui/PrivacySection";
import { ProviderBadge } from "../ui/ProviderBadge";
import { AccessPicker } from "../../sessions/ui/AccessPicker";
import { saveModelProvider } from "../../model-setup/model/modelProviders";
import type { Block } from "../../sessions/model/session";

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

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  localityMock.session = "unknown";
  localityMock.server = "unknown";
});
afterEach(() => vi.unstubAllGlobals());

const codex = (extra: Partial<PrivacySession> = {}): PrivacySession => ({
  harness: "codex",
  runtimeMode: "auto-accept-edits",
  cwd: "/repo",
  blocks: [],
  ...extra,
});

const gateway = [
  {
    name: "notion",
    command: "docker",
    args: ["mcp", "gateway", "run", "--profile", "monocode_notion"],
  },
];

describe("sandbox view", () => {
  it("describes Codex's modes", () => {
    expect(sandboxView(codex({ runtimeMode: "supervised" }))).toMatchObject({
      sandboxed: true,
      network: "Off. Each request asks you",
    });
    expect(sandboxView(codex({ extraDirs: ["/a", "/b"] })).writable).toBe(
      "/repo, plus 2 added folders, and temporary folders",
    );
    expect(sandboxView(codex({ runtimeMode: "full-access" }))).toMatchObject({
      sandboxed: false,
      network: "Open",
    });
  });

  it("names a permissions profile, except in full access", () => {
    expect(
      sandboxView(codex({ permissionsProfile: "allowlist" })),
    ).toMatchObject({ profile: "allowlist" });
    expect(
      sandboxView(
        codex({ permissionsProfile: "allowlist", runtimeMode: "full-access" }),
      ).profile,
    ).toBeUndefined();
    expect(
      sandboxView(codex({ permissionsProfile: "../x" })).profile,
    ).toBeUndefined();
  });

  it("marks every other harness unsandboxed, in any mode", () => {
    for (const harness of [
      "claude",
      "opencode",
      "cursor",
      "pi",
      "devin",
    ] as const) {
      const view = sandboxView({
        ...codex(),
        harness,
        runtimeMode: "supervised",
      });
      expect(view.sandboxed).toBe(false);
      expect(view.network).toContain("no sandbox");
    }
  });
});

describe("destinations and the private mark", () => {
  it("lists the model route, gateway connectors and MonoCode's own calls", () => {
    const view = privacyView(
      { ...codex(), harness: "claude" },
      { gatewayServers: gateway, outboundOn: (id) => id === "usage" },
    );
    expect(view.destinations.map((item) => [item.kind, item.locality])).toEqual(
      [
        ["model", "hosted"],
        ["connector", "unknown"],
        ["monocode", "hosted"],
      ],
    );
    expect(view.private).toBe(false);
  });

  it("is private only when the contract and every route say local (corner case 7)", () => {
    saveModelProvider({
      id: "ollama_local",
      label: "Ollama",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      accountId: "local",
    });
    localityMock.session = "local";
    const session = codex({ providerAccountId: "local" });
    expect(privacyView(session).private).toBe(true);
    // MonoCode's own calls carry no session content and do not clear it.
    expect(privacyView(session, { outboundOn: () => true }).private).toBe(true);
    // A hosted connector switched on ends it (corner case 8).
    localityMock.server = "hosted";
    const withConnector = privacyView(session, { gatewayServers: gateway });
    expect(withConnector.private).toBe(false);
    expect(withConnector.notPrivateBecause).toContain("notion");
    // The contract has the last word.
    localityMock.server = "local";
    localityMock.session = "unknown";
    expect(privacyView(session, { gatewayServers: gateway }).private).toBe(
      false,
    );
  });

  it("counts the wrapper case as not private", () => {
    localityMock.session = "local";
    const view = privacyView(codex());
    expect(view.destinations[0].detail).toContain("not read by MonoCode");
    expect(view.private).toBe(false);
  });
});

describe("network log", () => {
  it("lists network approvals newest first, capped", () => {
    const blocks: Block[] = Array.from({ length: 60 }, (_, index) => ({
      id: `b${index}`,
      role: "tool",
      text: "",
      approval: {
        requestId: index,
        decided: index % 2 ? "allow" : "deny",
        network: { host: `h${index}.example`, protocol: "https" },
      },
    })) as unknown as Block[];
    const log = networkLog(blocks);
    expect(log).toHaveLength(50);
    expect(log[0]).toMatchObject({ host: "h59.example", decided: "allow" });
    expect(networkLog([])).toEqual([]);
  });
});

describe("rendering", () => {
  it("shows the section, escapes a host, and badges only a private session", () => {
    const blocks = [
      {
        id: "x",
        role: "tool",
        text: "",
        approval: {
          requestId: 1,
          network: { host: "<img src=x onerror=1>", protocol: "https" },
        },
      },
    ] as unknown as Block[];
    const view = privacyView(codex({ blocks }));
    const html = renderToStaticMarkup(createElement(PrivacySection, { view }));
    expect(html).toContain("data-privacy-section");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("data-private-badge");
    const privateHtml = renderToStaticMarkup(
      createElement(PrivacySection, {
        view: { ...view, private: true, notPrivateBecause: undefined },
      }),
    );
    expect(privateHtml).toContain("data-private-badge");
    const claude = renderToStaticMarkup(
      createElement(PrivacySection, {
        view: privacyView({ ...codex(), harness: "claude" }),
      }),
    );
    expect(claude).toContain("data-unsandboxed-note");
  });

  it("shows the provider badge only where a provider can be picked", () => {
    expect(
      renderToStaticMarkup(
        createElement(ProviderBadge, { session: { harness: "claude" } }),
      ),
    ).toBe("");
    const html = renderToStaticMarkup(
      createElement(ProviderBadge, {
        session: { harness: "codex", modelProvider: "openai" },
      }),
    );
    expect(html).toContain("OpenAI");
    expect(html).toContain('data-locality="hosted"');
  });

  it("marks an unsandboxed harness on the access picker (corner case 11)", () => {
    const html = renderToStaticMarkup(
      createElement(AccessPicker, {
        value: "supervised",
        onChange: () => {},
        unsandboxed: true,
      }),
    );
    expect(html).toContain("data-unsandboxed");
    expect(html).toContain("No sandbox");
    const plain = renderToStaticMarkup(
      createElement(AccessPicker, { value: "supervised", onChange: () => {} }),
    );
    expect(plain).not.toContain("data-unsandboxed");
  });
});
