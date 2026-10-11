// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetReportedMcpServers,
  noteAccountMcpServers,
} from "../../session-tools/model/reportedMcpServers";
import {
  sessionToolsInput,
  sessionToolsSummary,
} from "../../session-tools/model/harnessInput";
import type { InstalledConnector, InstalledState } from "./installed";
import { __resetInstalled, __setInstalled } from "./installed";
import {
  claudeAiDuplicates,
  explicitlyOnClaudeAi,
  gatewaySessionInput,
  launchableConnectors,
  serviceKey,
  setClaudeAiExplicitlyOn,
} from "./sessionGateway";
import { claudeAiDuplicateToggle, withGatewayRows } from "./connectorRows";

const DOCKER = "/usr/local/bin/docker";

function connector(
  server: string,
  title: string,
  status: InstalledConnector["status"] = "ready",
): InstalledConnector {
  return {
    profileId: `monocode_${server.replace(/[^a-z0-9]/g, "_")}`,
    server,
    title,
    description: "",
    kind: "remote",
    auth: "none",
    sessionName: server,
    secrets: [],
    missingSecrets: [],
    settings: [],
    missingSettings: [],
    setup:
      status === "needs-sign-in" || status === "needs-setup"
        ? status
        : "complete",
    ...(status === "ready"
      ? { test: { at: 1, ok: true, tools: 3, output: "" } }
      : status === "failed"
        ? {
            test: {
              at: 1,
              ok: false,
              tools: 0,
              reason: "No build for Apple Silicon",
              output: "",
            },
          }
        : {}),
    status,
  };
}

const NOTION = connector("notion-remote", "Notion");
const HF = connector("hugging-face", "Hugging Face");
const LINEAR = connector("linear", "Linear", "needs-sign-in");

const STATE: InstalledState = {
  connectors: [NOTION, HF, LINEAR],
  docker: DOCKER,
  dockerState: "ready",
  loading: false,
  at: 1,
};

const REPORTED = [
  "claude.ai Notion",
  "claude.ai Hugging Face",
  "claude.ai Linear",
  "claude.ai Gmail",
  "docs",
];

beforeEach(() => {
  localStorage.clear();
  __resetInstalled();
  __resetReportedMcpServers();
});

describe("which connectors a session starts", () => {
  it("starts ready connectors only, and none while Docker is down", () => {
    expect(launchableConnectors(STATE).map((c) => c.server)).toEqual([
      "notion-remote",
      "hugging-face",
    ]);
    expect(
      launchableConnectors({ ...STATE, dockerState: "not-running" }),
    ).toEqual([]);
    expect(launchableConnectors({ ...STATE, dockerState: "missing" })).toEqual(
      [],
    );
    expect(launchableConnectors({ ...STATE, docker: undefined })).toEqual([]);
    // A list read back at app start counts until Docker says otherwise.
    expect(
      launchableConnectors({ ...STATE, dockerState: "unknown" }),
    ).toHaveLength(2);
  });

  it("builds one gateway server per connector, minus the switched-off ones", () => {
    const input = gatewaySessionInput(
      { harness: "codex", disabledMcpServers: ["hugging-face"] },
      "/repo",
      STATE,
      [],
    );
    expect(input.servers).toEqual([
      {
        name: "notion-remote",
        command: DOCKER,
        args: ["mcp", "gateway", "run", "--profile", "monocode_notion_remote"],
      },
    ]);
    expect([...input.names]).toEqual([
      "notion-remote",
      "hugging-face",
      "linear",
    ]);
  });

  it("adds nothing for other harnesses or remote projects", () => {
    expect(
      gatewaySessionInput({ harness: "cursor" }, "/repo", STATE, []).servers,
    ).toEqual([]);
    expect(
      gatewaySessionInput({ harness: "claude" }, "remote://box/repo", STATE, [])
        .servers,
    ).toEqual([]);
  });
});

describe("claude.ai copies of gateway connectors", () => {
  it("match on the service name", () => {
    expect(serviceKey("notion-remote")).toBe("notion");
    expect(serviceKey("Exa (keyless)")).toBe("exa");
    expect(serviceKey("Hugging Face")).toBe("huggingface");
    expect(
      Object.fromEntries(
        claudeAiDuplicates(
          [NOTION, HF, connector("exa-remote", "Exa (keyless)")],
          [...REPORTED, "claude.ai Exa"],
        ),
      ),
    ).toEqual({
      "claude.ai Notion": "notion-remote",
      "claude.ai Hugging Face": "hugging-face",
      "claude.ai Exa": "exa-remote",
    });
  });

  it("are off by default in Claude Code chats until switched back on", () => {
    const base = { id: "s1", harness: "claude" as const };
    expect(
      gatewaySessionInput(base, "/repo", STATE, REPORTED).defaultOff,
    ).toEqual(["claude.ai Hugging Face", "claude.ai Notion"]);
    // Linear needs a sign-in, so its claude.ai copy stays on.
    // A gateway copy switched off for the chat brings the claude.ai copy back.
    expect(
      gatewaySessionInput(
        { ...base, disabledMcpServers: ["notion-remote"] },
        "/repo",
        STATE,
        REPORTED,
      ).defaultOff,
    ).toEqual(["claude.ai Hugging Face"]);
    setClaudeAiExplicitlyOn("s1", "claude.ai Notion", true);
    expect(explicitlyOnClaudeAi("s1")).toEqual(["claude.ai Notion"]);
    expect(
      gatewaySessionInput(base, "/repo", STATE, REPORTED).defaultOff,
    ).toEqual(["claude.ai Hugging Face"]);
    // Other chats keep the default.
    expect(
      gatewaySessionInput({ ...base, id: "s2" }, "/repo", STATE, REPORTED)
        .defaultOff,
    ).toHaveLength(2);
    // Codex has no claude.ai connectors.
    expect(
      gatewaySessionInput(
        { ...base, harness: "codex" },
        "/repo",
        STATE,
        REPORTED,
      ).defaultOff,
    ).toEqual([]);
    setClaudeAiExplicitlyOn("s1", "claude.ai Notion", false);
    expect(explicitlyOnClaudeAi("s1")).toEqual([]);
  });

  it("toggle through the chat's explicit list, not the off list", () => {
    const toggle = (name: string, on: boolean, disabled: string[] = []) =>
      claudeAiDuplicateToggle({
        name,
        on,
        harness: "claude",
        installed: STATE,
        reportedNames: REPORTED,
        disabled,
      });
    expect(toggle("claude.ai Notion", true)).toEqual({
      explicitlyOn: true,
      listOff: false,
    });
    expect(toggle("claude.ai Notion", false)).toEqual({
      explicitlyOn: false,
      listOff: false,
    });
    expect(toggle("claude.ai Notion", false, ["notion-remote"])).toEqual({
      explicitlyOn: false,
      listOff: true,
    });
    expect(toggle("claude.ai Gmail", false)).toBeNull();
    expect(toggle("docs", false)).toBeNull();
  });
});

describe("sessionToolsInput with gateway connectors", () => {
  beforeEach(() => {
    __setInstalled(STATE);
    noteAccountMcpServers(
      undefined,
      REPORTED.map((name) => ({ name, status: "connected" })),
    );
  });

  it("hands Claude Code the servers and the default-off claude.ai copies", () => {
    const input = sessionToolsInput(
      { id: "s1", harness: "claude", disabledMcpServers: ["docs"] },
      "/repo",
    );
    expect(input.gatewayConnectors?.map((s) => s.name)).toEqual([
      "notion-remote",
      "hugging-face",
    ]);
    expect(input.disabledMcpServers).toEqual([
      "docs",
      "claude.ai Hugging Face",
      "claude.ai Notion",
    ]);
  });

  it("never passes a gateway name to Codex as a switch", () => {
    const input = sessionToolsInput(
      {
        id: "s1",
        harness: "codex",
        disabledMcpServers: ["linear", "notion-remote"],
      },
      "/repo",
    );
    expect(input.gatewayConnectors?.map((s) => s.name)).toEqual([
      "hugging-face",
    ]);
    expect(input.disabledMcpServers).toBeUndefined();
    expect(
      sessionToolsSummary(
        { harness: "codex", disabledMcpServers: ["notion-remote"] },
        "/repo",
      )?.label,
    ).toBe("1 off");
  });

  it("adds nothing when no connector is installed", () => {
    __resetInstalled();
    expect(sessionToolsInput({ harness: "claude" }, "/repo")).toEqual({});
  });
});

describe("gateway rows in the connector switches", () => {
  it("replaces reported rows and marks the claude.ai copy", () => {
    const { rows, gatewayNames } = withGatewayRows(
      [
        { name: "notion-remote", detail: "Claude Code", enabled: true },
        {
          name: "claude.ai Notion",
          detail: "claude.ai account",
          enabled: true,
        },
        { name: "docs", detail: "project · stdio", enabled: true },
      ],
      {
        harness: "claude",
        installed: STATE,
        disabled: [],
        defaultOff: ["claude.ai Notion"],
      },
    );
    expect([...gatewayNames].sort()).toEqual([
      "hugging-face",
      "linear",
      "notion-remote",
    ]);
    expect(rows).toEqual([
      {
        name: "claude.ai Notion",
        detail: "Off: using the Docker gateway copy",
        enabled: false,
      },
      { name: "docs", detail: "project · stdio", enabled: true },
      { name: "hugging-face", detail: "Hosted", enabled: true },
      {
        name: "linear",
        detail: "Hosted · needs sign-in in Connectors",
        enabled: false,
        configDisabled: true,
      },
      { name: "notion-remote", detail: "Hosted", enabled: true },
    ]);
  });

  it("greys out a failed connector with its reason", () => {
    const { rows } = withGatewayRows([], {
      harness: "claude",
      installed: {
        ...STATE,
        connectors: [connector("gmail-mcp", "Gmail", "failed")],
      },
      disabled: [],
      defaultOff: [],
    });
    expect(rows).toEqual([
      {
        name: "gmail-mcp",
        detail: "Hosted · failed: No build for Apple Silicon",
        enabled: false,
        configDisabled: true,
      },
    ]);
  });

  it("disables every gateway switch while Docker is stopped", () => {
    const { rows } = withGatewayRows([], {
      harness: "codex",
      installed: { ...STATE, dockerState: "not-running" },
      disabled: [],
      defaultOff: [],
    });
    expect(rows.every((row) => row.configDisabled)).toBe(true);
    expect(rows[0].detail).toBe("Hosted · Docker Desktop is not running");
  });
});
