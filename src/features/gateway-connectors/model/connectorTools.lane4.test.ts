// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const runDockerMcp = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/tauri/dockerMcp", () => ({ runDockerMcp }));

import {
  enableAllConnectorTools,
  parseProfileTools,
  setConnectorTool,
  smallestContextWindow,
  toolContextWarning,
  toolsAvailable,
  TOKENS_PER_TOOL_ESTIMATE,
} from "./connectorTools";
import {
  isAllowedDockerMcpCall,
  profileToolArgs,
  profileToolsResetArgs,
} from "./dockerArgs";
import {
  MODEL_TRAITS_KEY,
  resetTraitOverridesCache,
} from "../../model-traits/model/modelTraits";

/** `profile show --format json` in the shape `workingset.go` writes. */
const show = (tools: string[] | null, server = "github", snapshot = true) => ({
  version: 1,
  id: "monocode_github",
  name: "github",
  servers: [
    {
      type: "image",
      image: "mcp/github",
      tools,
      ...(snapshot
        ? {
            snapshot: {
              server: {
                name: server,
                tools: [
                  { name: "create_issue", description: "Open an issue" },
                  { name: "list_repos", description: "" },
                  { name: "search_code", description: "Search" },
                ],
              },
            },
          }
        : {}),
    },
  ],
});

/** A fake Docker that keeps one profile's allowlist, as `tools.go` does. */
function fakeDocker(options: { snapshot?: boolean } = {}) {
  let allow: string[] | null = null;
  const snapshot = options.snapshot !== false;
  runDockerMcp.mockImplementation(async (args: string[]) => {
    expect(isAllowedDockerMcpCall(args)).toBe(true);
    if (args[2] === "show") {
      return {
        stdout: JSON.stringify(show(allow, "github", snapshot)),
        stderr: "",
        success: true,
        docker: "docker",
      };
    }
    if (args[2] === "tools") {
      const [flag, ref] = args.slice(4);
      if (flag === "--enable-all") allow = null;
      else if (snapshot) {
        const tool = ref.slice(ref.indexOf(".") + 1);
        if (allow === null)
          allow = ["create_issue", "list_repos", "search_code"];
        if (flag === "--disable") allow = allow.filter((name) => name !== tool);
        else if (!allow.includes(tool)) allow = [...allow, tool];
      }
      // With no snapshot Docker changes nothing and still exits 0.
      return { stdout: "", stderr: "", success: true, docker: "docker" };
    }
    throw new Error("unsupported");
  });
  return { allow: () => allow };
}

beforeEach(() => {
  runDockerMcp.mockReset();
  localStorage.clear();
  resetTraitOverridesCache();
});

describe("reading a connector's tools", () => {
  it("reads every tool on when there is no allowlist", () => {
    const tools = parseProfileTools(show(null), "github");
    expect(toolsAvailable(tools) && tools.allOn).toBe(true);
    if (!toolsAvailable(tools)) return;
    expect(tools.onCount).toBe(3);
    expect(tools.tools.map((t) => [t.name, t.on, t.switchable])).toEqual([
      ["create_issue", true, true],
      ["list_repos", true, true],
      ["search_code", true, true],
    ]);
  });

  it("reads an allowlist, and an empty one as every tool off", () => {
    const some = parseProfileTools(show(["list_repos"]), "github");
    expect(toolsAvailable(some) && some.onCount).toBe(1);
    const none = parseProfileTools(show([]), "github");
    expect(toolsAvailable(none) && none.onCount).toBe(0);
    expect(toolsAvailable(none) && none.allOn).toBe(false);
  });

  it("says why when the profile has no tool list", () => {
    const missing = parseProfileTools(show(null, "github", false), "github");
    expect(toolsAvailable(missing)).toBe(false);
    expect("reason" in missing && missing.reason).toMatch(/no tool list/);
    expect(toolsAvailable(parseProfileTools({}, "github"))).toBe(false);
    expect(toolsAvailable(parseProfileTools(show(null), "other"))).toBe(false);
  });

  it("marks tools it cannot pass to Docker", () => {
    const odd = show(null);
    odd.servers[0].snapshot!.server.tools.push({
      name: "bad name",
      description: "",
    });
    const tools = parseProfileTools(odd, "github");
    if (!toolsAvailable(tools)) throw new Error("expected tools");
    expect(tools.tools.find((t) => t.name === "bad name")?.switchable).toBe(
      false,
    );
  });
});

describe("switching tools", () => {
  it("turns one tool off, then on, and reads the result back", async () => {
    const docker = fakeDocker();
    const off = await setConnectorTool(
      "monocode_github",
      "github",
      "search_code",
      false,
    );
    expect(off.ok).toBe(true);
    expect(docker.allow()).toEqual(["create_issue", "list_repos"]);
    expect(runDockerMcp.mock.calls[0][0]).toEqual([
      "mcp",
      "profile",
      "tools",
      "monocode_github",
      "--disable",
      "github.search_code",
    ]);
    const on = await setConnectorTool(
      "monocode_github",
      "github",
      "search_code",
      true,
    );
    expect(on.ok && on.tools.onCount).toBe(3);
  });

  it("puts every tool back", async () => {
    fakeDocker();
    await setConnectorTool("monocode_github", "github", "list_repos", false);
    const all = await enableAllConnectorTools("monocode_github", "github");
    expect(all.ok && all.tools.allOn).toBe(true);
  });

  it("reports a change Docker silently did not make", async () => {
    fakeDocker({ snapshot: false });
    const result = await setConnectorTool(
      "monocode_github",
      "github",
      "search_code",
      false,
    );
    expect(result.ok).toBe(false);
  });

  it("reports Docker's error", async () => {
    runDockerMcp.mockRejectedValue(new Error("Docker Desktop is not running"));
    const result = await setConnectorTool(
      "monocode_github",
      "github",
      "search_code",
      false,
    );
    expect(result).toEqual({
      ok: false,
      reason: "Docker Desktop is not running",
    });
  });

  it("refuses profiles MonoCode did not make, dotted servers and odd names before running anything", async () => {
    for (const [id, server, tool] of [
      ["research", "github", "x"],
      ["monocode_github", "git.hub", "x"],
      ["monocode_github", "github", "a b"],
      ["monocode_github", "github", "-x"],
      ["monocode_github", "github", ""],
    ]) {
      const result = await setConnectorTool(id, server, tool, false);
      expect(result.ok).toBe(false);
    }
    expect(runDockerMcp).not.toHaveBeenCalled();
    expect(() => profileToolsResetArgs("monocode_github", "git.hub")).toThrow();
  });

  it("matches the Rust allowlist's shapes", () => {
    expect(
      isAllowedDockerMcpCall(
        profileToolArgs("monocode_github", "github", "create_issue", true),
      ),
    ).toBe(true);
    expect(
      isAllowedDockerMcpCall(
        profileToolsResetArgs("monocode_github", "github"),
      ),
    ).toBe(true);
    for (const args of [
      ["mcp", "profile", "tools", "monocode_github", "--disable-all", "github"],
      ["mcp", "profile", "tools", "research", "--disable", "github.x"],
      ["mcp", "profile", "tools", "monocode_github", "--disable", "github"],
      ["mcp", "profile", "tools", "monocode_github"],
    ]) {
      expect(isAllowedDockerMcpCall(args), args.join(" ")).toBe(false);
    }
  });
});

describe("context warning (corner case 1)", () => {
  it("warns when tools take more than a tenth of the smallest window you set", () => {
    localStorage.setItem(
      MODEL_TRAITS_KEY,
      JSON.stringify({
        "qwen2.5:7b": { contextWindow: 16_384 },
        "big-model": { contextWindow: 200_000 },
      }),
    );
    resetTraitOverridesCache();
    const smallest = smallestContextWindow();
    expect(smallest).toEqual({ model: "qwen2.5:7b", window: 16_384 });
    expect(toolContextWarning(6, smallest)).toBeNull();
    const warning = toolContextWarning(40, smallest);
    expect(warning).toContain("qwen2.5:7b");
    expect(warning).toContain(
      (40 * TOKENS_PER_TOOL_ESTIMATE).toLocaleString("en-US"),
    );
    expect(warning).toContain("an estimate");
  });

  it("stays quiet when no window is known", () => {
    expect(smallestContextWindow()).toBeNull();
    expect(toolContextWarning(100, null)).toBeNull();
  });
});
