import { describe, expect, it } from "vitest";
import type { McpConnection } from "../../settings/model/mcp";
import {
  MAX_DISABLED_MCP_SERVERS,
  connectorChangePending,
  connectorRows,
  connectorSwitchCaveat,
  harnessDisabledMcpServers,
  reportedConnectorRows,
  sanitizeDisabledMcpServers,
  setMcpServerEnabled,
} from "./connectors";
import {
  sessionToolsInput,
  sessionToolsSummary,
  withDisabledMcpServers,
  withExtraDirs,
} from "./harnessInput";

function server(
  provider: McpConnection["provider"],
  name: string,
  rest: Partial<McpConnection> = {},
): McpConnection {
  return {
    provider,
    name,
    scope: "user",
    configPath: `/home/me/.${provider}.json`,
    transport: "stdio",
    ...rest,
  };
}

describe("setMcpServerEnabled", () => {
  it("lists a server when it is switched off", () => {
    expect(setMcpServerEnabled([], "github", false)).toEqual(["github"]);
    expect(setMcpServerEnabled(["github"], "linear", false)).toEqual([
      "github",
      "linear",
    ]);
  });

  it("drops a server from the list when it is switched back on", () => {
    expect(setMcpServerEnabled(["github", "linear"], "github", true)).toEqual([
      "linear",
    ]);
  });

  it("returns the same list when nothing changes", () => {
    const disabled = ["github"];
    expect(setMcpServerEnabled(disabled, "github", false)).toBe(disabled);
    expect(setMcpServerEnabled(disabled, "linear", true)).toBe(disabled);
    expect(setMcpServerEnabled(disabled, "  ", false)).toBe(disabled);
  });

  it("matches names exactly", () => {
    expect(setMcpServerEnabled(["GitHub"], "github", true)).toEqual(["GitHub"]);
  });

  it("stops at the limit", () => {
    const full = Array.from(
      { length: MAX_DISABLED_MCP_SERVERS },
      (_, index) => `server-${index}`,
    );
    expect(setMcpServerEnabled(full, "one-more", false)).toBe(full);
  });
});

describe("sanitizeDisabledMcpServers", () => {
  it("keeps unique, non-empty names", () => {
    expect(
      sanitizeDisabledMcpServers(["github", " linear ", "", 4, "github", null]),
    ).toEqual(["github", "linear"]);
  });

  it("is undefined when no name is left", () => {
    expect(sanitizeDisabledMcpServers(undefined)).toBeUndefined();
    expect(sanitizeDisabledMcpServers("github")).toBeUndefined();
    expect(sanitizeDisabledMcpServers([" ", 1])).toBeUndefined();
  });
});

describe("connectorRows", () => {
  const connections = [
    server("claude", "linear", { scope: "project", transport: "http" }),
    server("claude", "github"),
    server("codex", "github", { transport: "streamable_http" }),
    server("cursor", "figma"),
    server("claude_desktop", "notes"),
  ];

  it("lists only the session harness's servers, by name", () => {
    expect(connectorRows(connections, "claude", [])).toEqual([
      { name: "github", detail: "user · stdio", enabled: true },
      { name: "linear", detail: "project · http", enabled: true },
    ]);
    expect(connectorRows(connections, "codex", [])).toEqual([
      { name: "github", detail: "user · streamable_http", enabled: true },
    ]);
    expect(connectorRows(connections, "grok", [])).toEqual([]);
  });

  it("shows a server switched off for this chat as off", () => {
    expect(
      connectorRows(connections, "claude", ["linear"]).map((row) => [
        row.name,
        row.enabled,
      ]),
    ).toEqual([
      ["github", true],
      ["linear", false],
    ]);
  });

  it("gives a name defined in several scopes one row", () => {
    const rows = connectorRows(
      [
        server("claude", "github", { scope: "user" }),
        server("claude", "github", { scope: "project", transport: "" }),
      ],
      "claude",
      [],
    );
    expect(rows).toEqual([
      { name: "github", detail: "user, project · stdio", enabled: true },
    ]);
  });

  it("falls back to MCP when the transport is unknown", () => {
    expect(
      connectorRows(
        [server("claude", "plugin", { transport: "", scope: "local" })],
        "claude",
        [],
      )[0].detail,
    ).toBe("local · MCP");
  });

  it("locks a server the provider configuration already disables", () => {
    expect(
      connectorRows(
        [server("codex", "sentry", { enabled: false })],
        "codex",
        [],
      ),
    ).toEqual([
      {
        name: "sentry",
        detail: "Disabled in provider configuration",
        enabled: false,
        configDisabled: true,
      },
    ]);
  });

  it("keeps a switched-off name that is no longer configured, so it can be switched back on", () => {
    expect(connectorRows(connections, "codex", ["github", "linear"])).toEqual([
      { name: "github", detail: "user · streamable_http", enabled: false },
      {
        name: "linear",
        detail: "Not configured for Codex",
        enabled: false,
        missing: true,
      },
    ]);
  });
});

describe("reportedConnectorRows", () => {
  const reported = [
    { name: "linear", enabled: true, url: "https://mcp.linear.app/mcp?k=1" },
    { name: "github", enabled: true, command: "gh-mcp" },
    { name: "sentry", enabled: false, url: "https://mcp.sentry.dev/mcp" },
    { name: "bare", enabled: true },
  ];

  it("has one row per server the harness reports, by name", () => {
    expect(reportedConnectorRows(reported, "codex", ["github"])).toEqual([
      { name: "bare", detail: "MCP", enabled: true },
      { name: "github", detail: "stdio · gh-mcp", enabled: false },
      { name: "linear", detail: "http · mcp.linear.app", enabled: true },
      {
        name: "sentry",
        detail: "Disabled in provider configuration",
        enabled: false,
        configDisabled: true,
      },
    ]);
  });

  it("never shows more of an address than its host", () => {
    const [row] = reportedConnectorRows(
      [
        {
          name: "x",
          enabled: true,
          url: "https://user:secret@mcp.example.com:8443/v1?token=abc",
        },
      ],
      "codex",
      [],
    );
    expect(row.detail).toBe("http · mcp.example.com:8443");
    expect(
      reportedConnectorRows(
        [{ name: "x", enabled: true, url: "not a url" }],
        "codex",
        [],
      )[0].detail,
    ).toBe("http");
  });

  it("keeps a switched-off name the harness does not have, to switch it back on", () => {
    expect(
      reportedConnectorRows(reported.slice(1, 2), "codex", [
        "claude-only",
        "github",
      ]),
    ).toEqual([
      { name: "github", detail: "stdio · gh-mcp", enabled: false },
      {
        name: "claude-only",
        detail: "Not configured for Codex",
        enabled: false,
        missing: true,
      },
    ]);
  });

  it("is only the unknown names when the harness has no servers", () => {
    expect(reportedConnectorRows([], "codex", [])).toEqual([]);
    expect(reportedConnectorRows([], "codex", ["github"])).toEqual([
      {
        name: "github",
        detail: "Not configured for Codex",
        enabled: false,
        missing: true,
      },
    ]);
  });
});

describe("harnessDisabledMcpServers", () => {
  it("passes names to Claude Code and Codex only", () => {
    expect(harnessDisabledMcpServers("claude", ["github"])).toEqual(["github"]);
    expect(harnessDisabledMcpServers("codex", ["github"])).toEqual(["github"]);
    for (const harness of ["cursor", "opencode", "grok", "pi"] as const)
      expect(harnessDisabledMcpServers(harness, ["github"])).toBeUndefined();
  });

  it("is undefined without names", () => {
    expect(harnessDisabledMcpServers("claude", undefined)).toBeUndefined();
    expect(harnessDisabledMcpServers("claude", [])).toBeUndefined();
  });

  it("is what a harness turn receives", () => {
    expect(
      sessionToolsInput(
        {
          harness: "codex",
          extraDirs: ["/work/docs"],
          disabledMcpServers: ["github"],
        },
        "/repo",
      ),
    ).toEqual({ extraDirs: ["/work/docs"], disabledMcpServers: ["github"] });
    expect(
      sessionToolsInput(
        { harness: "cursor", disabledMcpServers: ["github"] },
        "/repo",
      ),
    ).toEqual({});
  });
});

describe("sessionToolsInput for a harness other than the session's own", () => {
  it("follows the harness the turn is sent to", () => {
    // A handoff asks the outgoing harness after the session was renamed.
    const session = {
      harness: "cursor" as const,
      extraDirs: ["/work/docs"],
      disabledMcpServers: ["github"],
    };
    expect(sessionToolsInput(session, "/repo")).toEqual({});
    expect(
      sessionToolsInput({ ...session, harness: "codex" }, "/repo"),
    ).toEqual({ extraDirs: ["/work/docs"], disabledMcpServers: ["github"] });
  });
});

describe("withExtraDirs and withDisabledMcpServers", () => {
  const session = { id: "s1", extraDirs: ["/a"], disabledMcpServers: ["x"] };

  it("replace the list and leave the rest of the session alone", () => {
    expect(withExtraDirs(session, ["/a", "/b"])).toEqual({
      id: "s1",
      extraDirs: ["/a", "/b"],
      disabledMcpServers: ["x"],
    });
    expect(withDisabledMcpServers(session, ["x", "y"])).toEqual({
      id: "s1",
      extraDirs: ["/a"],
      disabledMcpServers: ["x", "y"],
    });
    expect(session).toEqual({
      id: "s1",
      extraDirs: ["/a"],
      disabledMcpServers: ["x"],
    });
  });

  it("clear the field for an empty list", () => {
    expect(withExtraDirs(session, []).extraDirs).toBeUndefined();
    expect(
      withDisabledMcpServers(session, []).disabledMcpServers,
    ).toBeUndefined();
  });
});

describe("sessionToolsSummary", () => {
  it("counts what a turn is sent with and lists it in the title", () => {
    expect(
      sessionToolsSummary(
        {
          harness: "claude",
          extraDirs: ["/work/docs", "/work/design"],
          disabledMcpServers: ["github"],
        },
        "/repo",
      ),
    ).toEqual({
      label: "2 folders · 1 off",
      title: "Extra folders:\n/work/docs\n/work/design\nConnectors off: github",
    });
    expect(
      sessionToolsSummary(
        { harness: "codex", extraDirs: ["/work/docs"] },
        "/r",
      ),
    ).toEqual({ label: "1 folder", title: "Extra folders:\n/work/docs" });
    expect(
      sessionToolsSummary(
        { harness: "codex", disabledMcpServers: ["a", "b"] },
        "/r",
      ),
    ).toEqual({ label: "2 off", title: "Connectors off: a, b" });
  });

  it("is null when nothing is sent", () => {
    expect(sessionToolsSummary({ harness: "claude" }, "/repo")).toBeNull();
    // A harness that takes neither, and a folder the working directory covers.
    expect(
      sessionToolsSummary(
        {
          harness: "cursor",
          extraDirs: ["/work/docs"],
          disabledMcpServers: ["github"],
        },
        "/repo",
      ),
    ).toBeNull();
    expect(
      sessionToolsSummary(
        { harness: "claude", extraDirs: ["/repo/packages"] },
        "/repo",
      ),
    ).toBeNull();
  });
});

describe("connectorSwitchCaveat", () => {
  it("says Claude Code still connects, and nothing for Codex", () => {
    expect(connectorSwitchCaveat("claude")).toContain("still connects");
    expect(connectorSwitchCaveat("codex")).toBeUndefined();
  });
});

describe("connectorChangePending", () => {
  it("is false while no turn is running", () => {
    expect(connectorChangePending(["github"], null)).toBe(false);
  });

  it("is true once the switches differ from the start of the turn", () => {
    expect(connectorChangePending(["github"], [])).toBe(true);
    expect(connectorChangePending([], ["github"])).toBe(true);
    expect(connectorChangePending(["linear"], ["github"])).toBe(true);
  });

  it("is false when the switches are back where the turn started", () => {
    expect(connectorChangePending(["a", "b"], ["b", "a"])).toBe(false);
    expect(connectorChangePending([], [])).toBe(false);
  });
});
