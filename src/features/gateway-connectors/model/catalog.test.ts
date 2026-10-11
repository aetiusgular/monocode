// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runDockerMcp = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/tauri/dockerMcp", () => ({ runDockerMcp }));

import { CATALOG_FIXTURE } from "./__fixtures__/catalog";
import {
  __resetCatalog,
  catalogState,
  connectorNeeds,
  catalogEntry,
  loadCatalog,
  trimCatalog,
  needsSetupForm,
  trimCatalogEntry,
  trimSettings,
} from "./catalog";

const out = (value: unknown) => ({
  stdout: JSON.stringify(value),
  docker: "/usr/local/bin/docker",
});

beforeEach(() => {
  localStorage.clear();
  runDockerMcp.mockReset();
  __resetCatalog();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("trimCatalog", () => {
  it("keeps what the page needs and skips entries it cannot read", () => {
    const entries = trimCatalog(CATALOG_FIXTURE);
    expect(entries.map((entry) => entry.name)).toEqual([
      "github",
      "gmail-mcp",
      "grafbase",
      "hugging-face",
      "notion-remote",
      "time",
    ]);
    const notion = entries.find((entry) => entry.name === "notion-remote")!;
    expect(notion).toEqual({
      name: "notion-remote",
      title: "Notion",
      description: "Read and write Notion pages and databases.",
      icon: "https://avatars.githubusercontent.com/u/4792552?v=4",
      kind: "remote",
      auth: "oauth",
      secrets: [],
      oauthProviders: ["notion-remote"],
      settings: [],
      remoteUrl: "https://mcp.notion.com/mcp",
      category: "productivity",
      tags: ["notes", "docs"],
      tools: ["notion-search"],
    });
    const github = entries.find((entry) => entry.name === "github")!;
    expect(github.kind).toBe("container");
    expect(github.auth).toBe("secrets");
    expect(github.secrets).toEqual(["github.personal_access_token"]);
    expect(github.image).toBe("mcp/github@sha256:1");
    expect(github.remoteUrl).toBeUndefined();
    const gmail = entries.find((entry) => entry.name === "gmail-mcp")!;
    // The credential-like property is left out: the app refuses it as config.
    expect(gmail.settings).toEqual([
      {
        key: "gmail-mcp.email_address",
        name: "email_address",
        type: "string",
        description: "Your Gmail email address",
        required: true,
      },
      {
        key: "gmail-mcp.imap_host",
        name: "imap_host",
        type: "string",
        description: "IMAP server",
        required: false,
      },
    ]);
    expect(gmail.auth).toBe("secrets");
    expect(needsSetupForm(gmail)).toBe(true);
    expect(needsSetupForm(entries.find((e) => e.name === "time")!)).toBe(false);
    expect(
      connectorNeeds({
        auth: "none",
        kind: "container",
        settings: gmail.settings,
      }),
    ).toBe("Settings");
    const time = entries.find((entry) => entry.name === "time")!;
    expect(time.auth).toBe("none");
    expect(time.tools).toEqual([]);
    expect(time.tags).toEqual([]);
  });

  it("reads a config schema with several blocks and no required list", () => {
    expect(
      trimSettings(
        [
          { properties: { region: { type: "string" } } },
          {
            name: "other",
            properties: { "bad key": {}, limit: { type: "integer" } },
            required: ["limit"],
          },
        ],
        "srv",
      ).map((setting) => [setting.key, setting.type, setting.required]),
    ).toEqual([
      ["other.limit", "integer", true],
      ["srv.region", "string", false],
    ]);
    expect(trimSettings(null, "srv")).toEqual([]);
  });

  it("tolerates a bare list and a name-keyed map", () => {
    expect(
      trimCatalog([{ name: "a", title: "A", type: "server" }]).map(
        (e) => e.name,
      ),
    ).toEqual(["a"]);
    expect(
      trimCatalog({ servers: { b: { title: "B", type: "server" } } }).map(
        (e) => e.name,
      ),
    ).toEqual(["b"]);
    expect(trimCatalog(null)).toEqual([]);
    expect(trimCatalog({ servers: 3 })).toEqual([]);
  });

  it("drops icons and urls that are not https", () => {
    const entry = trimCatalogEntry({
      name: "x",
      type: "remote",
      icon: "javascript:alert(1)",
      remote: { url: "http://example.com/mcp" },
    })!;
    expect(entry.icon).toBeUndefined();
    expect(entry.remoteUrl).toBeUndefined();
  });

  it("words what each connector needs", () => {
    expect(connectorNeeds({ auth: "oauth", kind: "remote" })).toBe("Sign in");
    expect(connectorNeeds({ auth: "secrets", kind: "container" })).toBe(
      "API key",
    );
    expect(connectorNeeds({ auth: "none", kind: "container" })).toBe(
      "Runs in Docker",
    );
    expect(connectorNeeds({ auth: "none", kind: "remote" })).toBe("No setup");
  });
});

/** `catalog show` answers by catalog; `pull` succeeds. */
function routeShow(docker: unknown, extra?: unknown) {
  runDockerMcp.mockImplementation(async (args: string[]) => {
    if (args[2] === "show" && args[3] === "monocode/extra") {
      if (extra === undefined) throw new Error("catalog not found");
      return out(extra);
    }
    return out(args[2] === "show" ? docker : "");
  });
}

const EXTRA = {
  servers: [
    {
      type: "remote",
      snapshot: {
        server: {
          name: "vercel-remote",
          type: "remote",
          title: "Vercel",
          remote: { url: "https://mcp.vercel.com" },
          oauth: { providers: [{ provider: "vercel-remote" }] },
          metadata: { tags: ["community"] },
        },
      },
    },
    {
      type: "remote",
      snapshot: {
        server: {
          name: "time",
          type: "remote",
          title: "Time (mine)",
          remote: { url: "https://time.example.com/mcp" },
        },
      },
    },
  ],
};

describe("the user's own catalog", () => {
  it("adds its servers, marks them, and wins over a same-name entry", async () => {
    routeShow(CATALOG_FIXTURE, EXTRA);
    await loadCatalog();
    const vercel = catalogEntry("vercel-remote");
    expect(vercel).toMatchObject({
      catalog: "monocode/extra",
      community: true,
      auth: "oauth",
      kind: "remote",
    });
    expect(catalogEntry("time")).toMatchObject({
      title: "Time (mine)",
      catalog: "monocode/extra",
    });
    expect(catalogEntry("github")?.catalog).toBeUndefined();
    expect(
      catalogState().connectors?.filter((e) => e.name === "time"),
    ).toHaveLength(1);

    // Kept across an app start.
    __resetCatalog({ reload: true });
    expect(catalogEntry("vercel-remote")).toMatchObject({
      catalog: "monocode/extra",
      community: true,
    });
  });
});

describe("loadCatalog", () => {
  it("reads once a day and keeps only the trimmed form", async () => {
    routeShow(CATALOG_FIXTURE);
    await loadCatalog();
    await loadCatalog();
    // Docker's catalog, then the user's own (absent here).
    expect(runDockerMcp).toHaveBeenCalledTimes(2);
    expect(runDockerMcp.mock.calls[1][0][3]).toBe("monocode/extra");
    expect(runDockerMcp.mock.calls[0][0]).toEqual([
      "mcp",
      "catalog",
      "show",
      "mcp/docker-mcp-catalog",
      "--format",
      "json",
    ]);
    expect(catalogState().connectors).toHaveLength(6);
    const saved = localStorage.getItem("monocode.gatewayCatalog.v2")!;
    expect(saved).not.toContain("snapshot");
    expect(saved).not.toContain("readme");

    // An app start reads the saved catalog back without asking Docker.
    __resetCatalog({ reload: true });
    expect(catalogState().connectors?.map((e) => e.name)).toEqual([
      "github",
      "gmail-mcp",
      "grafbase",
      "hugging-face",
      "notion-remote",
      "time",
    ]);
    expect(
      catalogState().connectors?.find((e) => e.name === "gmail-mcp")?.settings,
    ).toHaveLength(2);
    expect(
      catalogState().connectors?.find((e) => e.name === "notion-remote"),
    ).toMatchObject({ auth: "oauth", kind: "remote", tags: ["notes", "docs"] });
    await loadCatalog();
    expect(runDockerMcp).toHaveBeenCalledTimes(2);
  });

  it("pulls first when asked to refresh", async () => {
    routeShow(CATALOG_FIXTURE);
    await loadCatalog({ force: true });
    expect(runDockerMcp.mock.calls.map((call) => call[0][2])).toEqual([
      "pull",
      "show",
      "show",
    ]);
  });

  it("pulls once when a first read fails, then reports a second failure", async () => {
    runDockerMcp
      .mockRejectedValueOnce(new Error("catalog not found"))
      .mockResolvedValueOnce(out({}))
      .mockResolvedValueOnce(out(CATALOG_FIXTURE))
      .mockRejectedValueOnce(new Error("catalog not found"));
    await loadCatalog();
    expect(catalogState().connectors).toHaveLength(6);
    expect(catalogState().error).toBeUndefined();

    __resetCatalog();
    runDockerMcp.mockReset();
    runDockerMcp.mockRejectedValue(new Error("Docker Desktop is not running"));
    await loadCatalog();
    expect(catalogState().connectors).toBeNull();
    expect(catalogState().error).toBe("Docker Desktop is not running");
  });
});
