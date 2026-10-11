// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mcpInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@tauri-apps/api/core")>();
  return {
    ...original,
    invoke: (command: string, args?: unknown) =>
      command === "mcp_discover" || command === "claude_mcp_list"
        ? mcpInvoke(command, args)
        : original.invoke(command, args),
  };
});
// Codex is asked for its own servers; every other harness goes by discovery.
const listMcpServers = vi.hoisted(() => vi.fn());
vi.mock(
  "../../../integrations/harness/core/registry",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../integrations/harness/core/registry")
    >()),
    canListHarnessMcpServers: (harness: string) => harness === "codex",
    listHarnessMcpServers: listMcpServers,
  }),
);
// Asking Claude Code for its servers would start a process.
const probeClaude = vi.hoisted(() => vi.fn());
vi.mock(
  "../../../integrations/harness/providers/claude/claudeMcpStatus",
  () => ({ probeClaudeMcpServers: probeClaude }),
);
// Docker's MCP gateway, for the gateway connectors' rows.
const dockerMcp = vi.hoisted(() =>
  vi.fn(async (_args: string[]) => {
    throw new Error("docker unavailable in tests");
  }),
);
vi.mock("../../../platform/tauri/dockerMcp", () => ({
  runDockerMcp: dockerMcp,
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("../../source-control/hooks/useProjectBranches", () => ({
  useProjectBranchesState: () => ({ branches: undefined, settled: true }),
}));
vi.mock("../../settings/model/sounds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../settings/model/sounds")>()),
  playCue: () => false,
}));

import { Composer } from "../../sessions/ui/Composer";
import type { HarnessId } from "../../sessions/model/session";
import type { McpConnection } from "../../settings/model/mcp";
import type { HarnessMcpServer } from "../../../integrations/harness/core/types";
import { clearMcpSettingsCache } from "../../settings/model/mcpSettingsCache";
import { takeRequestedConnectorsTab } from "../../gateway-connectors/model/navigation";
import {
  __resetInstalled,
  __setInstalled,
  type InstalledConnector,
} from "../../gateway-connectors/model/installed";
import {
  explicitlyOnClaudeAi,
  setClaudeAiExplicitlyOn,
} from "../../gateway-connectors/model/sessionGateway";
import {
  __resetReportedMcpServers,
  noteAccountMcpServers,
  noteReportedMcpServers,
} from "../model/reportedMcpServers";

const DISCOVERED: McpConnection[] = [
  {
    provider: "claude",
    name: "docs",
    scope: "project",
    configPath: "/repo/.mcp.json",
    transport: "stdio",
  },
  {
    provider: "claude",
    name: "github",
    scope: "user",
    configPath: "/home/me/.claude.json",
    transport: "http",
  },
  {
    provider: "codex",
    name: "linear",
    scope: "user",
    configPath: "/home/me/.codex/config.toml",
    transport: "streamable_http",
  },
  {
    provider: "cursor",
    name: "figma",
    scope: "user",
    configPath: "/home/me/.cursor/mcp.json",
    transport: "stdio",
  },
];

let container: HTMLDivElement;
let root: Root;
let discovered: McpConnection[];
/** What the session's Codex answers; an Error means it could not be asked. */
let reported: HarnessMcpServer[] | Error;

const REPORTED: HarnessMcpServer[] = [
  { name: "linear", enabled: true, url: "https://mcp.linear.app/mcp?key=s3" },
];

beforeEach(() => {
  clearMcpSettingsCache();
  __resetReportedMcpServers();
  probeClaude.mockReset();
  // By default Claude Code is not asked: the account was asked a moment ago.
  noteAccountMcpServers(undefined, []);
  discovered = DISCOVERED;
  reported = REPORTED;
  listMcpServers.mockReset();
  listMcpServers.mockImplementation(async () => {
    if (reported instanceof Error) throw reported;
    return reported;
  });
  mcpInvoke.mockReset();
  mcpInvoke.mockImplementation(async (command: string) =>
    command === "mcp_discover" ? discovered : "",
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

type Options = {
  harness?: HarnessId;
  remoteSession?: boolean;
  busy?: boolean;
  disabledMcpServers?: string[];
  onDisabledMcpServersChange?: (names: string[]) => void;
  providerAccountId?: string;
  cwd?: string;
  sessionId?: string;
};

async function renderComposer(options: Options) {
  await act(async () =>
    root.render(
      createElement(Composer, {
        focused: true,
        harness: options.harness ?? "claude",
        model: "claude-sonnet",
        runtimeMode: "supervised",
        cwd: "/repo",
        executionCwd: options.cwd ?? "/repo",
        hideProjectPicker: true,
        hideBranchPicker: true,
        remoteSession: options.remoteSession,
        busy: options.busy,
        disabledMcpServers: options.disabledMcpServers,
        onDisabledMcpServersChange: options.onDisabledMcpServersChange,
        providerAccountId: options.providerAccountId,
        sessionId: options.sessionId,
        onFocus: () => {},
        onCwdChange: () => {},
        onModelChange: () => {},
        onRuntimeModeChange: () => {},
        onSubmit: () => {},
      }),
    ),
  );
}

async function plusMenuEntry() {
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Add files or choose a mode"]',
      )!
      .click(),
  );
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-composer-plus] button"),
  ).find((button) => button.textContent?.includes("Connectors"));
}

const popover = () =>
  document.querySelector<HTMLElement>(
    '[role="dialog"][aria-label="Connectors"]',
  );

async function openConnectors() {
  const entry = await plusMenuEntry();
  await act(async () => entry!.click());
  // Discovery resolves on a later tick.
  await act(async () => {});
  return popover()!;
}

function rows(surface: HTMLElement) {
  return Array.from(surface.querySelectorAll("li")).map((row) => {
    const [name, detail] = Array.from(row.querySelectorAll("span > span")).map(
      (part) => part.textContent,
    );
    const toggle = row.querySelector<HTMLButtonElement>('[role="switch"]')!;
    // Under a heading the row shows its name without the group's prefix; the
    // switch keeps the full name.
    void name;
    return {
      name: toggle.getAttribute("aria-label"),
      detail,
      on: toggle.getAttribute("aria-checked") === "true",
      label: toggle.getAttribute("aria-label"),
      locked: toggle.disabled,
    };
  });
}

describe("Connectors in the composer plus menu", () => {
  it.each(["claude", "codex"] as const)(
    "is offered for %s",
    async (harness) => {
      await renderComposer({ harness, onDisabledMcpServersChange: vi.fn() });
      expect((await plusMenuEntry())?.textContent).toContain(
        "Turn MCP servers off for this chat",
      );
    },
  );

  it.each(["cursor", "opencode", "grok", "fx"] as const)(
    "is not offered for %s",
    async (harness) => {
      await renderComposer({ harness, onDisabledMcpServersChange: vi.fn() });
      expect(await plusMenuEntry()).toBeUndefined();
    },
  );

  it("is not offered for a host session or without a change handler", async () => {
    await renderComposer({
      remoteSession: true,
      onDisabledMcpServersChange: vi.fn(),
    });
    expect(await plusMenuEntry()).toBeUndefined();
    await renderComposer({});
    expect(await plusMenuEntry()).toBeUndefined();
  });

  it("shows how many servers are off on the menu entry", async () => {
    await renderComposer({
      disabledMcpServers: ["docs", "github"],
      onDisabledMcpServersChange: vi.fn(),
    });
    expect((await plusMenuEntry())?.textContent).toContain("2 off");
  });
});

describe("Connectors popover", () => {
  it("lists the harness's servers with their state for this chat", async () => {
    await renderComposer({
      disabledMcpServers: ["github"],
      onDisabledMcpServersChange: vi.fn(),
    });
    const surface = await openConnectors();
    expect(mcpInvoke).toHaveBeenCalledWith("mcp_discover", { cwd: "/repo" });
    expect(rows(surface)).toEqual([
      {
        name: "docs",
        detail: "project · stdio",
        on: true,
        label: "docs",
        locked: false,
      },
      {
        name: "github",
        detail: "user · http",
        on: false,
        label: "github",
        locked: false,
      },
    ]);
    // Opening the switches replaces the plus menu.
    expect(document.body.textContent).not.toContain("Upload file");
  });

  it("does not ask Claude Code, whose servers discovery reads", async () => {
    await renderComposer({ onDisabledMcpServersChange: vi.fn() });
    const surface = await openConnectors();
    expect(listMcpServers).not.toHaveBeenCalled();
    expect(surface.querySelector('[aria-label="Refresh connectors"]')).toBe(
      null,
    );
    expect(surface.textContent).not.toContain("may not match this chat");
  });

  it("switches a server off and back on for this chat", async () => {
    const onDisabledMcpServersChange = vi.fn();
    await renderComposer({ onDisabledMcpServersChange });
    let surface = await openConnectors();
    await act(async () =>
      surface
        .querySelector<HTMLButtonElement>('[role="switch"][aria-label="docs"]')!
        .click(),
    );
    expect(onDisabledMcpServersChange).toHaveBeenLastCalledWith(["docs"]);

    await renderComposer({
      disabledMcpServers: ["docs"],
      onDisabledMcpServersChange,
    });
    surface = popover()!;
    expect(rows(surface)[0]).toMatchObject({ name: "docs", on: false });
    await act(async () =>
      surface
        .querySelector<HTMLButtonElement>('[role="switch"][aria-label="docs"]')!
        .click(),
    );
    expect(onDisabledMcpServersChange).toHaveBeenLastCalledWith([]);
    // Switching never touches the harness's own configuration.
    expect(
      mcpInvoke.mock.calls.every(
        ([command]) =>
          command === "mcp_discover" || command === "claude_mcp_list",
      ),
    ).toBe(true);
  });

  it("says what switching off does not do for Claude Code, once a server is off", async () => {
    const note = "Claude Code still connects to a switched-off server";
    await renderComposer({ onDisabledMcpServersChange: vi.fn() });
    expect((await openConnectors()).textContent).not.toContain(note);
    await renderComposer({
      disabledMcpServers: ["docs"],
      onDisabledMcpServersChange: vi.fn(),
    });
    expect(popover()!.textContent).toContain(note);
  });

  it("has no such note for Codex, which skips the server", async () => {
    await renderComposer({
      harness: "codex",
      disabledMcpServers: ["linear"],
      onDisabledMcpServersChange: vi.fn(),
    });
    expect((await openConnectors()).textContent).not.toContain(
      "still connects",
    );
  });

  it("locks a server its provider configuration disables", async () => {
    reported = [{ ...REPORTED[0], enabled: false }];
    await renderComposer({
      harness: "codex",
      onDisabledMcpServersChange: vi.fn(),
    });
    expect(rows(await openConnectors())).toEqual([
      {
        name: "linear",
        detail: "Disabled in provider configuration",
        on: false,
        label: "linear",
        locked: true,
      },
    ]);
  });

  it("keeps a switched-off server that is no longer configured, to switch it back on", async () => {
    const onDisabledMcpServersChange = vi.fn();
    await renderComposer({
      harness: "codex",
      disabledMcpServers: ["github"],
      onDisabledMcpServersChange,
    });
    const surface = await openConnectors();
    expect(rows(surface)[1]).toMatchObject({
      name: "github",
      detail: "Not configured for Codex",
      on: false,
    });
    await act(async () =>
      surface
        .querySelector<HTMLButtonElement>(
          '[role="switch"][aria-label="github"]',
        )!
        .click(),
    );
    expect(onDisabledMcpServersChange).toHaveBeenLastCalledWith([]);
  });

  it("says so when the harness has no MCP servers", async () => {
    reported = [];
    await renderComposer({
      harness: "codex",
      onDisabledMcpServersChange: vi.fn(),
    });
    const surface = await openConnectors();
    expect(surface.querySelectorAll('[role="switch"]')).toHaveLength(0);
    expect(surface.textContent).toContain(
      "No MCP servers configured for Codex",
    );
  });

  it("reports a discovery failure", async () => {
    mcpInvoke.mockRejectedValue("could not read the configuration");
    await renderComposer({ onDisabledMcpServersChange: vi.fn() });
    const surface = await openConnectors();
    expect(surface.querySelector('[role="alert"]')?.textContent).toContain(
      "could not read the configuration",
    );
  });

  it.each([
    ["Add connector", "discover"],
    ["Manage connectors", "yours"],
  ])("opens the Connectors page from %s", async (action, tab) => {
    const opened = vi.fn();
    window.addEventListener("monocode:open-connectors", opened);
    try {
      await renderComposer({ onDisabledMcpServersChange: vi.fn() });
      const surface = await openConnectors();
      const button = Array.from(surface.querySelectorAll("button")).find(
        (candidate) => candidate.textContent === action,
      )!;
      await act(async () => button.click());
      expect(opened).toHaveBeenCalledTimes(1);
      expect(takeRequestedConnectorsTab()).toBe(tab);
      expect(popover()).toBeNull();
    } finally {
      window.removeEventListener("monocode:open-connectors", opened);
    }
  });

  it("says a change made during a turn waits for the next one", async () => {
    const onDisabledMcpServersChange = vi.fn();
    await renderComposer({ busy: true, onDisabledMcpServersChange });
    const surface = await openConnectors();
    expect(surface.textContent).not.toContain("next turn");

    await renderComposer({
      busy: true,
      disabledMcpServers: ["docs"],
      onDisabledMcpServersChange,
    });
    expect(popover()!.textContent).toContain(
      "Changes apply from the next turn.",
    );

    // Once the turn ends the next message is that turn.
    await renderComposer({
      disabledMcpServers: ["docs"],
      onDisabledMcpServersChange,
    });
    expect(popover()!.textContent).not.toContain("next turn");
  });
});

describe("Connectors popover for a Codex session", () => {
  const refresh = () =>
    popover()!.querySelector<HTMLButtonElement>(
      '[aria-label="Refresh connectors"]',
    )!;

  it("lists what the session's own Codex has, not what discovery found", async () => {
    // Discovery reads the app's own Codex home, which only has "linear".
    reported = [
      { name: "github", enabled: true, command: "gh-mcp" },
      { name: "plain", enabled: true },
      { name: "sentry", enabled: false, url: "https://mcp.sentry.dev/mcp" },
      ...REPORTED,
    ];
    await renderComposer({
      harness: "codex",
      cwd: "/worktrees/feature",
      disabledMcpServers: ["github", "claude-only"],
      onDisabledMcpServersChange: vi.fn(),
    });
    const surface = await openConnectors();
    expect(listMcpServers).toHaveBeenCalledTimes(1);
    expect(listMcpServers).toHaveBeenCalledWith("codex", {
      cwd: "/worktrees/feature",
      providerAccountId: "default",
      refresh: false,
    });
    expect(mcpInvoke).not.toHaveBeenCalled();
    expect(
      rows(surface).map(({ name, detail, on, locked }) => ({
        name,
        detail,
        on,
        locked,
      })),
    ).toEqual([
      { name: "github", detail: "stdio · gh-mcp", on: false, locked: false },
      // The address is shown by host only; the rest can hold a credential.
      {
        name: "linear",
        detail: "http · mcp.linear.app",
        on: true,
        locked: false,
      },
      { name: "plain", detail: "MCP", on: true, locked: false },
      {
        name: "sentry",
        detail: "Disabled in provider configuration",
        on: false,
        locked: true,
      },
      {
        name: "claude-only",
        detail: "Not configured for Codex",
        on: false,
        locked: false,
      },
    ]);
    expect(surface.textContent).not.toContain("may not match this chat");
  });

  it("asks under the provider account the session is bound to", async () => {
    await renderComposer({
      harness: "codex",
      providerAccountId: "account-work",
      onDisabledMcpServersChange: vi.fn(),
    });
    await openConnectors();
    expect(listMcpServers).toHaveBeenCalledWith("codex", {
      cwd: "/repo",
      providerAccountId: "account-work",
      refresh: false,
    });
  });

  it("falls back to discovery, and says so, when Codex cannot be asked", async () => {
    reported = new Error("codex: not found");
    await renderComposer({
      harness: "codex",
      onDisabledMcpServersChange: vi.fn(),
    });
    const surface = await openConnectors();
    // The fallback is found on a later tick than the failure.
    await act(async () => {});
    expect(mcpInvoke).toHaveBeenCalledWith("mcp_discover", { cwd: "/repo" });
    expect(rows(surface)).toEqual([
      {
        name: "linear",
        detail: "user · streamable_http",
        on: true,
        label: "linear",
        locked: false,
      },
    ]);
    expect(surface.textContent).toContain(
      "Default Codex config; may not match this chat.",
    );
  });

  it("asks Codex again from the refresh button", async () => {
    await renderComposer({
      harness: "codex",
      onDisabledMcpServersChange: vi.fn(),
    });
    const surface = await openConnectors();
    expect(rows(surface).map((row) => row.name)).toEqual(["linear"]);

    reported = [...REPORTED, { name: "github", enabled: true }];
    await act(async () => refresh().click());
    expect(listMcpServers).toHaveBeenLastCalledWith("codex", {
      cwd: "/repo",
      providerAccountId: "default",
      refresh: true,
    });
    expect(rows(popover()!).map((row) => row.name)).toEqual([
      "github",
      "linear",
    ]);
  });

  it("recovers from the fallback once Codex answers a refresh", async () => {
    reported = new Error("timed out");
    await renderComposer({
      harness: "codex",
      onDisabledMcpServersChange: vi.fn(),
    });
    await openConnectors();
    await act(async () => {});
    expect(popover()!.textContent).toContain("may not match this chat");

    reported = [{ name: "github", enabled: true, command: "gh-mcp" }];
    await act(async () => refresh().click());
    expect(popover()!.textContent).not.toContain("may not match this chat");
    expect(rows(popover()!).map((row) => row.name)).toEqual(["github"]);
  });

  it("reopens on the rows it last showed while Codex is asked again", async () => {
    await renderComposer({
      harness: "codex",
      cwd: "/reopened",
      onDisabledMcpServersChange: vi.fn(),
    });
    await openConnectors();
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    expect(popover()).toBeNull();

    // The second answer never arrives.
    listMcpServers.mockImplementation(() => new Promise(() => {}));
    const surface = await openConnectors();
    expect(rows(surface).map((row) => row.name)).toEqual(["linear"]);
  });
});

describe("Connectors badge", () => {
  const badge = () =>
    container.querySelector<HTMLButtonElement>("[data-connectors-badge]");

  it("is absent while every server is on", async () => {
    await renderComposer({ onDisabledMcpServersChange: vi.fn() });
    expect(badge()).toBeNull();
  });

  it("shows the number of servers switched off for this chat", async () => {
    await renderComposer({
      disabledMcpServers: ["docs"],
      onDisabledMcpServersChange: vi.fn(),
    });
    expect(badge()?.textContent).toBe("1 off");
    expect(badge()?.getAttribute("aria-label")).toBe(
      "1 connector switched off for this chat",
    );
    await renderComposer({
      disabledMcpServers: ["docs", "github"],
      onDisabledMcpServersChange: vi.fn(),
    });
    expect(badge()?.getAttribute("aria-label")).toBe(
      "2 connectors switched off for this chat",
    );
  });

  it("opens the switches", async () => {
    await renderComposer({
      disabledMcpServers: ["docs"],
      onDisabledMcpServersChange: vi.fn(),
    });
    await act(async () => badge()!.click());
    await act(async () => {});
    expect(rows(popover()!)[0]).toMatchObject({ name: "docs", on: false });
  });

  it("is hidden where the switches do not apply", async () => {
    await renderComposer({
      harness: "cursor",
      disabledMcpServers: ["docs"],
      onDisabledMcpServersChange: vi.fn(),
    });
    expect(badge()).toBeNull();
    await renderComposer({
      remoteSession: true,
      disabledMcpServers: ["docs"],
      onDisabledMcpServersChange: vi.fn(),
    });
    expect(badge()).toBeNull();
  });

  it("notes a change that waits for the next turn", async () => {
    const onDisabledMcpServersChange = vi.fn();
    await renderComposer({ busy: true, onDisabledMcpServersChange });
    await renderComposer({
      busy: true,
      disabledMcpServers: ["docs"],
      onDisabledMcpServersChange,
    });
    expect(badge()?.getAttribute("aria-label")).toBe(
      "1 connector switched off for this chat, from the next turn",
    );
  });
});

describe("Connectors popover with what Claude Code reported", () => {
  const CLAUDE_REPORT = [
    { name: "docs", status: "connected" },
    { name: "claude.ai Exa", status: "connected" },
    { name: "plugin:desktop-commander:desktop-commander", status: "connected" },
    { name: "claude.ai Slack", status: "needs-auth" },
  ];

  it("adds claude.ai connectors and plugin servers no config file names", async () => {
    noteReportedMcpServers("chat-1", CLAUDE_REPORT);
    await renderComposer({
      sessionId: "chat-1",
      onDisabledMcpServersChange: vi.fn(),
    });
    const surface = await openConnectors();
    expect(rows(surface).map((row) => [row.name, row.detail, row.on])).toEqual([
      ["docs", "project · stdio", true],
      ["github", "user · http", true],
      ["claude.ai Exa", "claude.ai account", true],
      ["claude.ai Slack", "claude.ai account · needs sign-in", true],
      [
        "plugin:desktop-commander:desktop-commander",
        "Claude Code plugin",
        true,
      ],
    ]);
  });

  it("switches a claude.ai connector off for this chat by its name", async () => {
    noteReportedMcpServers("chat-1", CLAUDE_REPORT);
    const onChange = vi.fn();
    await renderComposer({
      sessionId: "chat-1",
      onDisabledMcpServersChange: onChange,
    });
    const surface = await openConnectors();
    const toggle = surface.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="claude.ai Exa"]',
    )!;
    await act(async () => toggle.click());
    expect(onChange).toHaveBeenLastCalledWith(["claude.ai Exa"]);
  });

  it("keeps a switched-off connector as its own row, not as unconfigured", async () => {
    noteReportedMcpServers("chat-1", CLAUDE_REPORT);
    await renderComposer({
      sessionId: "chat-1",
      disabledMcpServers: ["claude.ai Exa"],
      onDisabledMcpServersChange: vi.fn(),
    });
    const surface = await openConnectors();
    const exa = rows(surface).filter((row) => row.name === "claude.ai Exa");
    expect(exa).toEqual([
      {
        name: "claude.ai Exa",
        detail: "claude.ai account",
        on: false,
        label: "claude.ai Exa",
        locked: false,
      },
    ]);
  });

  it("uses the account's list in a chat that has not started", async () => {
    noteAccountMcpServers(undefined, CLAUDE_REPORT);
    await renderComposer({
      sessionId: "new-chat",
      onDisabledMcpServersChange: vi.fn(),
    });
    const surface = await openConnectors();
    expect(rows(surface).map((row) => row.name)).toContain("claude.ai Exa");
  });

  it("asks Claude Code for the account's servers when it opens", async () => {
    __resetReportedMcpServers();
    let answer: (value: unknown) => void = () => {};
    probeClaude.mockImplementation(
      () => new Promise((resolve) => (answer = resolve)),
    );
    await renderComposer({
      sessionId: "chat-1",
      onDisabledMcpServersChange: vi.fn(),
    });
    const surface = await openConnectors();
    expect(probeClaude).toHaveBeenCalledWith({
      cwd: "/repo",
      providerAccountId: "default",
    });
    expect(surface.textContent).toContain(
      "Checking claude.ai connectors and plugins…",
    );
    await act(async () =>
      answer([
        { name: "claude.ai Exa", status: "connected" },
        { name: "claude.ai Slack", status: "needs-auth" },
      ]),
    );
    expect(rows(surface).map((row) => [row.name, row.detail])).toEqual([
      ["docs", "project · stdio"],
      ["github", "user · http"],
      ["claude.ai Exa", "claude.ai account"],
      ["claude.ai Slack", "claude.ai account · needs sign-in"],
    ]);
    expect(surface.textContent).not.toContain("Checking claude.ai");
  });

  it("says so when Claude Code cannot be asked", async () => {
    __resetReportedMcpServers();
    probeClaude.mockRejectedValue(new Error("no claude"));
    await renderComposer({
      sessionId: "chat-1",
      onDisabledMcpServersChange: vi.fn(),
    });
    const surface = await openConnectors();
    await act(async () => {});
    expect(surface.textContent).toContain(
      "Could not list claude.ai connectors and plugins.",
    );
    expect(rows(surface).map((row) => row.name)).toEqual(["docs", "github"]);
  });

  it("does not ask again so soon after the last answer", async () => {
    await renderComposer({
      sessionId: "chat-1",
      onDisabledMcpServersChange: vi.fn(),
    });
    await openConnectors();
    expect(probeClaude).not.toHaveBeenCalled();
  });

  it("leaves Codex sessions alone", async () => {
    noteReportedMcpServers("chat-1", CLAUDE_REPORT);
    await renderComposer({
      harness: "codex",
      sessionId: "chat-1",
      onDisabledMcpServersChange: vi.fn(),
    });
    const surface = await openConnectors();
    expect(rows(surface).map((row) => row.name)).toEqual(["linear"]);
    expect(probeClaude).not.toHaveBeenCalled();
  });
});

describe("Connectors popover layout", () => {
  it("groups the rows under headings once there is more than one source", async () => {
    noteAccountMcpServers(undefined, [
      { name: "claude.ai Exa", status: "connected" },
      { name: "plugin:pdf-viewer:pdf", status: "connected" },
    ]);
    await renderComposer({
      sessionId: "chat-1",
      onDisabledMcpServersChange: vi.fn(),
    });
    const surface = await openConnectors();
    const headings = Array.from(surface.querySelectorAll("section > p")).map(
      (p) => p.textContent,
    );
    expect(headings).toEqual(["This computer", "claude.ai", "Plugins"]);
    const shown = Array.from(
      surface.querySelectorAll("li > span > span:first-child"),
    ).map((span) => span.textContent);
    expect(shown).toEqual(["docs", "github", "Exa", "pdf-viewer:pdf"]);
  });

  it("has no headings when every server comes from config files", async () => {
    await renderComposer({ onDisabledMcpServersChange: vi.fn() });
    const surface = await openConnectors();
    expect(surface.querySelectorAll("section > p")).toHaveLength(0);
    expect(
      surface.querySelector('[aria-label="Claude Code MCP servers"]'),
    ).not.toBeNull();
  });
});

describe("Connectors popover with Docker gateway connectors", () => {
  const gateway = (
    server: string,
    title: string,
    status: InstalledConnector["status"] = "ready",
  ): InstalledConnector => ({
    profileId: `monocode_${server.replace(/[^a-z0-9]/g, "_")}`,
    server,
    title,
    description: "",
    kind: "remote",
    auth: "oauth",
    sessionName: server,
    secrets: [],
    missingSecrets: [],
    oauthApp: server,
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
  });

  beforeEach(() => {
    __setInstalled({
      connectors: [
        gateway("notion-remote", "Notion"),
        gateway("linear", "Linear", "needs-sign-in"),
      ],
      docker: "/usr/local/bin/docker",
      dockerState: "ready",
    });
    noteAccountMcpServers(undefined, [
      { name: "claude.ai Notion", status: "connected" },
      { name: "claude.ai Exa", status: "connected" },
    ]);
    // Claude Code's own report of the chat names the gateway copy too.
    noteReportedMcpServers("chat-1", [
      { name: "notion-remote", status: "connected" },
    ]);
  });

  afterEach(() => {
    __resetInstalled();
    setClaudeAiExplicitlyOn("chat-1", "claude.ai Notion", false);
  });

  it("lists them under their own heading and marks the claude.ai copy off", async () => {
    await renderComposer({
      sessionId: "chat-1",
      onDisabledMcpServersChange: vi.fn(),
    });
    const surface = await openConnectors();
    const section = surface.querySelector<HTMLElement>(
      'section[aria-label="Docker gateway"]',
    );
    expect(section).not.toBeNull();
    expect(
      rows(section!).map((row) => [row.name, row.detail, row.on, row.locked]),
    ).toEqual([
      ["linear", "Hosted · needs sign-in in Connectors", false, true],
      ["notion-remote", "Hosted", true, false],
    ]);
    const all = rows(surface);
    expect(all.filter((row) => row.name === "notion-remote")).toHaveLength(1);
    expect(all.find((row) => row.name === "claude.ai Notion")).toMatchObject({
      detail: "Off: using the Docker gateway copy",
      on: false,
    });
    expect(all.find((row) => row.name === "claude.ai Exa")?.on).toBe(true);
  });

  it("switches the claude.ai copy back on for this chat only", async () => {
    const onChange = vi.fn();
    await renderComposer({
      sessionId: "chat-1",
      onDisabledMcpServersChange: onChange,
    });
    const surface = await openConnectors();
    await act(async () =>
      surface
        .querySelector<HTMLButtonElement>(
          '[role="switch"][aria-label="claude.ai Notion"]',
        )!
        .click(),
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(explicitlyOnClaudeAi("chat-1")).toEqual(["claude.ai Notion"]);
    expect(
      rows(popover()!).find((row) => row.name === "claude.ai Notion")?.on,
    ).toBe(true);

    // Switching a gateway connector off uses the chat's off list.
    await act(async () =>
      popover()!
        .querySelector<HTMLButtonElement>(
          '[role="switch"][aria-label="notion-remote"]',
        )!
        .click(),
    );
    expect(onChange).toHaveBeenLastCalledWith(["notion-remote"]);
  });

  it("asks Docker for the connectors when the switches open", async () => {
    dockerMcp.mockClear();
    await renderComposer({
      sessionId: "chat-1",
      onDisabledMcpServersChange: vi.fn(),
    });
    await openConnectors();
    expect(dockerMcp.mock.calls[0]?.[0]).toEqual([
      "mcp",
      "profile",
      "list",
      "--format",
      "json",
    ]);
  });
});
