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
vi.mock("../../../platform/tauri/dockerMcp", () => ({
  runDockerMcp: vi.fn(async () => {
    throw new Error("docker unavailable in tests");
  }),
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
import type {
  ComposerTurnOptions,
  HarnessId,
  ToolAccess,
} from "../../sessions/model/session";
import { clearMcpSettingsCache } from "../../settings/model/mcpSettingsCache";
import { takeRequestedConnectorsTab } from "../../gateway-connectors/model/navigation";
import {
  __resetInstalled,
  __setInstalled,
  type InstalledConnector,
} from "../../gateway-connectors/model/installed";
import { __resetReportedMcpServers } from "../../session-tools/model/reportedMcpServers";

let container: HTMLDivElement;
let root: Root;

const EXA: InstalledConnector = {
  profileId: "monocode_exa",
  server: "exa",
  title: "Exa",
  description: "",
  kind: "remote",
  auth: "none",
  sessionName: "exa",
  secrets: [],
  missingSecrets: [],
  settings: [],
  missingSettings: [],
  setup: "complete",
  test: { at: 1, ok: true, tools: 2, output: "" },
  status: "ready",
};

beforeEach(() => {
  clearMcpSettingsCache();
  __resetReportedMcpServers();
  __resetInstalled();
  takeRequestedConnectorsTab();
  mcpInvoke.mockReset();
  mcpInvoke.mockImplementation(async (command: string) =>
    command === "mcp_discover" ? [] : "",
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
  toolAccess?: ToolAccess;
  onSubmit?: (
    text: string,
    attachments: unknown[],
    options?: ComposerTurnOptions,
  ) => void;
};

async function renderComposer(options: Options = {}) {
  await act(async () =>
    root.render(
      createElement(Composer, {
        focused: true,
        harness: options.harness ?? "claude",
        model: "claude-sonnet",
        runtimeMode: "supervised",
        cwd: "/repo",
        executionCwd: "/repo",
        sessionId: "chat-1",
        hideProjectPicker: true,
        hideBranchPicker: true,
        remoteSession: options.remoteSession,
        toolAccess: options.toolAccess,
        onFocus: () => {},
        onCwdChange: () => {},
        onModelChange: () => {},
        onRuntimeModeChange: () => {},
        onSubmit: options.onSubmit ?? (() => {}),
      }),
    ),
  );
  // Discovery of configured servers resolves on a later tick.
  await act(async () => {});
}

async function openPlus() {
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Add files or choose a mode"]',
      )!
      .click(),
  );
  await act(async () => {});
}

const researchEntry = () =>
  Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-composer-plus] button"),
  ).find((button) => button.textContent?.includes("Research"));

const chip = () => container.querySelector<HTMLElement>("[data-research-chip]");

async function typeAndSend(text: string) {
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    textarea.value = text;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
}

async function turnOnResearch() {
  await openPlus();
  await act(async () => researchEntry()!.click());
}

describe("Research in the composer plus menu", () => {
  it("turns research on for Claude Code and shows a chip with an X", async () => {
    await renderComposer();
    await openPlus();
    const entry = researchEntry()!;
    expect(entry.textContent).toContain(
      "Search the web and write a cited report",
    );
    expect(entry.getAttribute("aria-pressed")).toBe("false");
    expect(chip()).toBeNull();

    await act(async () => entry.click());
    expect(document.querySelector("[data-composer-plus]")).toBeNull();
    expect(chip()?.textContent).toContain("Research");

    await openPlus();
    expect(researchEntry()!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => researchEntry()!.click());
    expect(chip()).toBeNull();

    await turnOnResearch();
    await act(async () =>
      chip()!
        .querySelector<HTMLButtonElement>('[aria-label="Turn off Research"]')!
        .click(),
    );
    expect(chip()).toBeNull();
  });

  it("sends the visible text with a research request, then turns off", async () => {
    const onSubmit = vi.fn();
    await renderComposer({ onSubmit });
    await turnOnResearch();
    await typeAndSend("What are the best local LLM runtimes?");

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [text, , options] = onSubmit.mock.calls[0];
    expect(text).toBe("What are the best local LLM runtimes?");
    expect(options.intent).toBe("default");
    expect(options.research).toEqual({
      reportPath: expect.stringMatching(
        /^research\/\d{4}-\d{2}-\d{2}-what-are-the-best-local-llm-runtimes\.md$/,
      ),
      search: ["WebSearch"],
      fetch: ["WebFetch"],
      subagents: true,
    });
    expect(chip()).toBeNull();

    await typeAndSend("A plain follow-up");
    expect(onSubmit.mock.calls[1][2].research).toBeUndefined();
  });

  it("is turned off by Plan mode, and turns Plan mode off", async () => {
    const onSubmit = vi.fn();
    await renderComposer({ onSubmit });
    await turnOnResearch();
    await openPlus();
    const plan = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        "[data-composer-plus] button",
      ),
    ).find((button) => button.textContent?.includes("Plan mode"))!;
    await act(async () => plan.click());
    expect(chip()).toBeNull();

    await turnOnResearch();
    await typeAndSend("Compare two queue libraries");
    const options = onSubmit.mock.calls[0][2];
    expect(options.intent).toBe("default");
    expect(options.research).toBeDefined();
  });

  it("says when the chat has no search tool and opens Connectors instead", async () => {
    await renderComposer({ harness: "codex" });
    await openPlus();
    const entry = researchEntry()!;
    expect(entry.textContent).toContain("No search tool in this chat");
    expect(entry.hasAttribute("aria-pressed")).toBe(false);
    await act(async () => entry.click());
    expect(takeRequestedConnectorsTab()).toBe("discover");
    expect(chip()).toBeNull();
  });

  it("is ready on Codex with a gateway search connector", async () => {
    __setInstalled({
      connectors: [EXA],
      docker: "/usr/local/bin/docker",
      dockerState: "ready",
    });
    const onSubmit = vi.fn();
    await renderComposer({ harness: "codex", onSubmit });
    await turnOnResearch();
    await typeAndSend("Who maintains zstd?");
    expect(onSubmit.mock.calls[0][2].research).toMatchObject({
      search: ["the exa connector (web_search_exa)"],
      fetch: ["the exa connector (web_fetch_exa)"],
      subagents: false,
    });
  });

  it("does not send when the search tools go away after research was turned on", async () => {
    const onSubmit = vi.fn();
    await renderComposer({ onSubmit });
    await turnOnResearch();
    await renderComposer({ onSubmit, toolAccess: { WebSearch: "never" } });
    expect(chip()?.textContent).toContain("No search tool in this chat");
    await typeAndSend("Is this still research?");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector("textarea")!.value).toBe(
      "Is this still research?",
    );
  });

  it("reads Claude Code's configured servers, and never runs discovery for Codex", async () => {
    mcpInvoke.mockImplementation(async (command: string) =>
      command === "mcp_discover"
        ? [
            {
              provider: "claude",
              name: "brave-search",
              scope: "user",
              configPath: "/home/me/.claude.json",
              transport: "stdio",
            },
          ]
        : "",
    );
    await renderComposer({ harness: "codex" });
    await openPlus();
    expect(mcpInvoke).not.toHaveBeenCalled();

    const onSubmit = vi.fn();
    await renderComposer({
      onSubmit,
      toolAccess: { WebSearch: "never", WebFetch: "never" },
    });
    await act(async () => {});
    expect(researchEntry()!.textContent).toContain(
      "Search the web and write a cited report",
    );
    await act(async () => researchEntry()!.click());
    await typeAndSend("Brave only");
    expect(onSubmit.mock.calls[0][2].research).toMatchObject({
      search: ["the brave-search MCP server"],
      fetch: [],
    });
  });

  it.each(["cursor", "opencode", "grok", "fx"] as const)(
    "is not offered for %s",
    async (harness) => {
      await renderComposer({ harness });
      await openPlus();
      expect(researchEntry()).toBeUndefined();
    },
  );

  it("is not offered for a host session", async () => {
    await renderComposer({ remoteSession: true });
    await openPlus();
    expect(researchEntry()).toBeUndefined();
  });
});
