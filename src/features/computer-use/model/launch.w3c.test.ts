import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../platform/tauri/platform", async (load) => ({
  ...(await load<typeof import("../../../platform/tauri/platform")>()),
  IS_MAC: true,
}));

import { sessionToolsInput } from "../../session-tools/model/harnessInput";
import { resetChatSwitchCache, setChatSwitch } from "./chatSwitch";
import { resetComputerUseClient, setComputerUseStateForTest } from "./client";
import { COMPUTER_USE_CLI_ARG, COMPUTER_USE_SERVER } from "./offer";

const ROOT = path.resolve(__dirname, "../../../..");

function stubWindow() {
  const items = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    },
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
}

const session = (over: Record<string, unknown> = {}) =>
  ({
    id: "chat-1",
    harness: "claude",
    model: "claude:opus-5-5",
    extraDirs: undefined,
    disabledMcpServers: undefined,
    toolAccess: undefined,
    disabledSkills: undefined,
    disabledPlugins: undefined,
    modelProvider: undefined,
    permissionsProfile: undefined,
    ...over,
  }) as Parameters<typeof sessionToolsInput>[0];

describe("the chat's launch input with computer use", () => {
  beforeEach(() => {
    stubWindow();
    resetChatSwitchCache();
    resetComputerUseClient();
    setComputerUseStateForTest({ cliPath: "/Applications/MonoCode.app/Contents/MacOS/monocode" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetChatSwitchCache();
    resetComputerUseClient();
  });

  it("adds nothing while the chat's switch is off", () => {
    expect(sessionToolsInput(session(), "/work").gatewayConnectors).toBeUndefined();
  });

  it("adds the bridge for Claude Code and Codex once switched on", () => {
    // Codex models get the vision trait from Codex's live model list, which
    // a test does not have; the chat's override stands in for it.
    setChatSwitch("chat-1", { on: true, withoutVision: true });
    for (const harness of ["claude", "codex"] as const) {
      const input = sessionToolsInput(
        session({ harness, model: harness === "claude" ? "claude-opus-4-1" : "codex:gpt-5.5" }),
        "/work",
      );
      expect(input.gatewayConnectors, harness).toEqual([
        {
          name: COMPUTER_USE_SERVER,
          command: "/Applications/MonoCode.app/Contents/MacOS/monocode",
          args: [COMPUTER_USE_CLI_ARG],
        },
      ]);
    }
  });

  it("leaves another chat alone", () => {
    setChatSwitch("chat-1", { on: true });
    expect(sessionToolsInput(session({ id: "chat-2" }), "/work").gatewayConnectors).toBeUndefined();
  });

  it("keeps it off for a local model that does not read images, until the chat says so", () => {
    setChatSwitch("chat-1", { on: true });
    const local = session({ harness: "codex", model: "qwen2.5:7b" });
    expect(sessionToolsInput(local, "/work").gatewayConnectors).toBeUndefined();
    setChatSwitch("chat-1", { on: true, withoutVision: true });
    expect(sessionToolsInput(local, "/work").gatewayConnectors?.[0]?.name).toBe(COMPUTER_USE_SERVER);
  });

  it("gives the same input twice, so the harness is not restarted for nothing", () => {
    setChatSwitch("chat-1", { on: true });
    expect(sessionToolsInput(session(), "/work")).toEqual(sessionToolsInput(session(), "/work"));
  });
});

describe("the names the three sides share", () => {
  it("Codex names the variables the bridge reads", () => {
    const codex = readFileSync(path.join(ROOT, "src/integrations/harness/providers/codex/codex.ts"), "utf8");
    const bridge = readFileSync(path.join(ROOT, "src-tauri/src/computer_use/bridge_cli.rs"), "utf8");
    expect(codex).toContain(
      `mcp_servers.${COMPUTER_USE_SERVER}.env_vars=["MONOCODE_CU_ENDPOINT","MONOCODE_CU_TOKEN"]`,
    );
    expect(bridge).toContain('ENDPOINT_ENV: &str = "MONOCODE_CU_ENDPOINT"');
    expect(bridge).toContain('TOKEN_ENV: &str = "MONOCODE_CU_TOKEN"');
  });

  it("the executable takes the bridge argument", () => {
    const main = readFileSync(path.join(ROOT, "src-tauri/src/main.rs"), "utf8");
    expect(main).toContain(`Some("${COMPUTER_USE_CLI_ARG}")`);
  });
});
