// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const runDockerMcp = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/tauri/dockerMcp", () => ({ runDockerMcp }));

import {
  parseProfileTools,
  parseToolList,
  setConnectorTool,
  enableAllConnectorTools,
  toolContextWarning,
  toolsAvailable,
  type ConnectorTools,
} from "./connectorTools";
import {
  isAllowedDockerMcpCall,
  profileToolListArgs,
  profileToolsEnableArgs,
} from "./dockerArgs";
import { parseDryRun } from "./dryRun";
import { mergeToolNames, testConnector } from "./installed";

const ID = "monocode_notion_remote";
const SERVER = "notion-remote";

/**
 * `docker mcp gateway run --profile <id> --dry-run --verbose` for a signed-in
 * Notion, written from the gateway v0.44.1 log calls (`pkg/gateway/reload.go`,
 * `capabilitites.go`, `pkg/mcp/remote.go`). It names the count, never the tools.
 */
const NOTION_DRY_RUN = [
  "- Reading configuration...",
  "- Those servers are enabled: notion-remote",
  "- Listing MCP tools...",
  "    - Using OAuth token for: notion-remote",
  "    - Connecting to remote server: https://mcp.notion.com/mcp (transport=http)",
  "    - Connected successfully to: notion-remote",
  "  > notion-remote: (49 tools)",
  "> 49 tools listed in 2.31s",
  "> Initialized in 3.02s",
  "Dry run mode enabled, not starting the server.",
].join("\n");

const FIRST = [
  "notion-search",
  "notion-fetch",
  "notion-create-pages",
  "notion-update-page",
  "notion-move-pages",
  "notion-duplicate-page",
  "notion-create-database",
  "notion-update-database",
  "notion-create-comment",
  "notion-get-comments",
  "notion-get-users",
  "notion-get-self",
];
const NAMES = [
  ...FIRST,
  ...Array.from(
    { length: 49 - FIRST.length },
    (_, i) => `notion-tool-${i + 1}`,
  ),
];

/** `docker mcp tools ls --format json`: the gateway's `[]*mcp.Tool`. */
const toolsLs = (names: readonly string[]) =>
  JSON.stringify(
    names.map((name) => ({
      name,
      description: `Notion: ${name}`,
      inputSchema: { type: "object", properties: {} },
    })),
    null,
    2,
  );

/** `profile show --format json` for a remote server: no tools in its snapshot. */
const show = (allow: string[] | null) => ({
  version: 1,
  id: ID,
  name: "monocode-notion-remote",
  servers: [
    {
      type: "remote",
      endpoint: "https://mcp.notion.com/mcp",
      tools: allow,
      snapshot: { server: { name: SERVER, type: "remote", tools: [] } },
    },
  ],
});

/** A Docker that keeps the allowlist as `pkg/workingset/tools.go` does. */
function fakeDocker() {
  const state = { allow: null as string[] | null };
  runDockerMcp.mockImplementation(async (args: string[]) => {
    expect(isAllowedDockerMcpCall(args), args.join(" ")).toBe(true);
    const ok = (stdout: string, stderr = "") => ({
      stdout,
      stderr,
      success: true,
      docker: "docker",
    });
    if (args[1] === "gateway") return ok("", NOTION_DRY_RUN);
    if (args[1] === "tools")
      return ok(
        toolsLs(NAMES.filter((n) => !state.allow || state.allow.includes(n))),
      );
    if (args[2] === "show") return ok(JSON.stringify(show(state.allow)));
    if (args[2] === "tools") {
      const pairs = args.slice(4);
      for (let i = 0; i < pairs.length; i += 2) {
        const flag = pairs[i];
        const tool = pairs[i + 1].slice(pairs[i + 1].indexOf(".") + 1);
        if (flag === "--enable-all") state.allow = null;
        else if (flag === "--enable") {
          if (!(state.allow ?? []).includes(tool))
            state.allow = [...(state.allow ?? []), tool];
        } else if (flag === "--disable") {
          // The snapshot lists no tools, so a null allowlist expands to [].
          state.allow = (state.allow ?? []).filter((n) => n !== tool);
        }
      }
      return ok("");
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  return state;
}

beforeEach(() => {
  runDockerMcp.mockReset();
  localStorage.clear();
});

describe("Mac fix 4.15: tools of a connector the catalog lists none for", () => {
  it("the verbose dry run counts Notion's tools but does not name them", () => {
    expect(parseDryRun(NOTION_DRY_RUN, SERVER)).toEqual({
      ok: true,
      tools: 49,
    });
    expect(NOTION_DRY_RUN).not.toContain("notion-search");
  });

  it("reads the names from the gateway's tool list", () => {
    expect(parseToolList(toolsLs(NAMES))).toEqual(NAMES);
    expect(parseToolList("not json")).toEqual([]);
    expect(
      parseToolList(JSON.stringify([{ name: "a b" }, { name: "ok" }, {}])),
    ).toEqual(["ok"]);
    expect(profileToolListArgs(ID)).toEqual([
      "mcp",
      "tools",
      "ls",
      "--format",
      "json",
      "--gateway-arg=--profile",
      `--gateway-arg=${ID}`,
    ]);
    expect(isAllowedDockerMcpCall(profileToolListArgs(ID))).toBe(true);
    expect(
      isAllowedDockerMcpCall([
        "mcp",
        "tools",
        "ls",
        "--format",
        "json",
        "--gateway-arg=--profile",
        "--gateway-arg=research",
      ]),
    ).toBe(false);
    expect(
      isAllowedDockerMcpCall(["mcp", "tools", "call", "notion-search"]),
    ).toBe(false);
  });

  it("builds the Tools section from the tested names, and the warning fires", () => {
    const empty = parseProfileTools(show(null), SERVER);
    expect(toolsAvailable(empty)).toBe(false);
    const tools = parseProfileTools(show(null), SERVER, NAMES);
    if (!toolsAvailable(tools)) throw new Error(tools.reason);
    expect(tools.fromTest).toBe(true);
    expect(tools.onCount).toBe(49);
    expect(tools.tools.every((tool) => tool.switchable)).toBe(true);
    const warning = toolContextWarning(tools.onCount, {
      model: "qwen2.5-coder:7b",
      window: 16_384,
    });
    expect(warning).toMatch(/^49 tools on/);
  });

  it("keeps the tested names with a passing test", async () => {
    const docker = fakeDocker();
    await testConnector({ profileId: ID, server: SERVER });
    const saved = JSON.parse(
      localStorage.getItem("monocode.gatewayConnectorTests.v1")!,
    )[ID];
    expect(saved.ok).toBe(true);
    expect(saved.tools).toBe(49);
    expect(saved.toolNames).toEqual(NAMES);
    // After one tool is off the gateway serves 48; the 49th name is kept.
    docker.allow = NAMES.filter((n) => n !== "notion-search");
    await testConnector({ profileId: ID, server: SERVER });
    const again = JSON.parse(
      localStorage.getItem("monocode.gatewayConnectorTests.v1")!,
    )[ID];
    expect(again.toolNames).toHaveLength(49);
    expect(mergeToolNames(["a"], ["b", "a"])).toEqual(["a", "b"]);
    expect(mergeToolNames(["a"], undefined)).toEqual(["a"]);
  });

  it("turns the first tool off without turning the rest off", async () => {
    const docker = fakeDocker();
    const shown = parseProfileTools(
      show(null),
      SERVER,
      NAMES,
    ) as ConnectorTools;
    const off = await setConnectorTool(
      ID,
      SERVER,
      "notion-search",
      false,
      shown,
    );
    expect(off.ok).toBe(true);
    const call = runDockerMcp.mock.calls.find((c) => c[0][2] === "tools")![0];
    expect(call).toEqual(
      profileToolsEnableArgs(
        ID,
        SERVER,
        NAMES.filter((n) => n !== "notion-search"),
      ),
    );
    expect(docker.allow).toHaveLength(48);
    if (!off.ok) return;
    expect(off.tools.onCount).toBe(48);

    // The allowlist exists now, so a plain --disable is safe.
    const next = await setConnectorTool(
      ID,
      SERVER,
      "notion-fetch",
      false,
      off.tools,
    );
    expect(next.ok && next.tools.onCount).toBe(47);
    expect(runDockerMcp.mock.calls.at(-2)![0]).toEqual([
      "mcp",
      "profile",
      "tools",
      ID,
      "--disable",
      "notion-remote.notion-fetch",
    ]);

    const all = await enableAllConnectorTools(ID, SERVER, NAMES);
    expect(all.ok && all.tools.allOn && all.tools.onCount).toBe(49);
  });

  it("refuses an enable list that mixes servers or flags", () => {
    expect(
      isAllowedDockerMcpCall([
        "mcp",
        "profile",
        "tools",
        ID,
        "--enable",
        "notion-remote.a",
        "--enable",
        "github.b",
      ]),
    ).toBe(false);
    expect(
      isAllowedDockerMcpCall([
        "mcp",
        "profile",
        "tools",
        ID,
        "--enable",
        "notion-remote.a",
        "--disable",
        "notion-remote.b",
      ]),
    ).toBe(false);
    expect(() => profileToolsEnableArgs(ID, SERVER, ["one"])).toThrow();
  });
});
