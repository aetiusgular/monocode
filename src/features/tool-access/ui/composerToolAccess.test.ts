// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import type {
  Block,
  HarnessId,
  ToolAccess,
} from "../../sessions/model/session";
import { Composer } from "../../sessions/ui/Composer";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
  compact?: boolean;
  toolAccess?: ToolAccess;
  onToolAccessChange?: (toolAccess: ToolAccess) => void;
  transcript?: Block[];
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
        executionCwd: "/repo",
        hideProjectPicker: true,
        hideBranchPicker: true,
        remoteSession: options.remoteSession,
        compact: options.compact,
        toolAccess: options.toolAccess,
        onToolAccessChange: options.onToolAccessChange,
        transcript: options.transcript,
        onFocus: () => {},
        onCwdChange: () => {},
        onModelChange: () => {},
        onRuntimeModeChange: () => {},
        onSubmit: () => {},
      }),
    ),
  );
}

const plusButton = () =>
  container.querySelector<HTMLButtonElement>(
    '[aria-label="Add files or choose a mode"]',
  )!;

async function plusMenuEntry() {
  await act(async () => plusButton().click());
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-composer-plus] button"),
  ).find((button) => button.textContent?.includes("Tool access"));
}

const popover = () =>
  document.querySelector<HTMLElement>(
    '[role="dialog"][aria-label="Tool access"]',
  );

async function openToolAccess() {
  const entry = await plusMenuEntry();
  await act(async () => entry!.click());
  return popover()!;
}

function rows(surface: HTMLElement) {
  return Array.from(surface.querySelectorAll("li")).map((row) => {
    const [name, detail] = Array.from(row.querySelectorAll("span > span")).map(
      (part) => part.textContent,
    );
    const group = row.querySelector('[role="radiogroup"]')!;
    return {
      name,
      detail,
      group: group.getAttribute("aria-label"),
      choice: group.querySelector('[aria-checked="true"]')?.textContent,
    };
  });
}

function choose(surface: HTMLElement, tool: string, choice: string) {
  const group = surface.querySelector(
    `[role="radiogroup"][aria-label="${tool} access"]`,
  )!;
  return Array.from(group.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent === choice,
  )!;
}

describe("Tool access in the composer plus menu", () => {
  it.each(["claude", "codex"] as const)(
    "is offered for %s",
    async (harness) => {
      await renderComposer({ harness, onToolAccessChange: vi.fn() });
      expect((await plusMenuEntry())?.textContent).toContain(
        "Allow or block tools in this chat",
      );
    },
  );

  it.each(["cursor", "opencode", "grok", "pi"] as const)(
    "is not offered for %s",
    async (harness) => {
      await renderComposer({ harness, onToolAccessChange: vi.fn() });
      expect(await plusMenuEntry()).toBeUndefined();
    },
  );

  it("is not offered for a host session or without a change handler", async () => {
    await renderComposer({ remoteSession: true, onToolAccessChange: vi.fn() });
    expect(await plusMenuEntry()).toBeUndefined();
    await renderComposer({});
    expect(await plusMenuEntry()).toBeUndefined();
  });

  it("shows how many rules are in effect on the menu entry", async () => {
    await renderComposer({
      // The Codex rule is not in effect on Claude Code.
      toolAccess: { Bash: "always", Write: "never", "codex:command": "never" },
      onToolAccessChange: vi.fn(),
    });
    expect((await plusMenuEntry())?.textContent).toContain("2 rules");
  });

  it("counts a single rule in the singular", async () => {
    await renderComposer({
      toolAccess: { Bash: "always" },
      onToolAccessChange: vi.fn(),
    });
    const text = (await plusMenuEntry())?.textContent;
    expect(text).toContain("1 rule");
    expect(text).not.toContain("1 rules");
  });
});

describe("Tool access popover", () => {
  it("lists the built-in tools with this chat's rule for each", async () => {
    await renderComposer({
      toolAccess: { Bash: "always", WebFetch: "never" },
      onToolAccessChange: vi.fn(),
    });
    const surface = await openToolAccess();
    expect(rows(surface)).toEqual([
      {
        name: "Bash",
        detail: "Shell commands",
        group: "Bash access",
        choice: "Always",
      },
      {
        name: "Edit",
        detail: "Changes to files",
        group: "Edit access",
        choice: "Ask",
      },
      {
        name: "Write",
        detail: "New and rewritten files",
        group: "Write access",
        choice: "Ask",
      },
      {
        name: "WebFetch",
        detail: "Reads a web page",
        group: "WebFetch access",
        choice: "Never",
      },
      {
        name: "WebSearch",
        detail: "Searches the web",
        group: "WebSearch access",
        choice: "Ask",
      },
    ]);
    expect(surface.textContent).toContain(
      "Ask follows this chat's permission mode.",
    );
    // Opening the list replaces the plus menu.
    expect(document.body.textContent).not.toContain("Upload file");
    expect(
      Array.from(surface.querySelectorAll("button")).every(
        (button) => button.type === "button",
      ),
    ).toBe(true);
  });

  it("adds the tools the chat has met and the ones with a rule", async () => {
    const transcript: Block[] = [
      { id: "u", role: "user", text: "go" },
      {
        id: "t1",
        role: "tool",
        text: "mcp__exa__web_search",
        tool: {
          callId: "c1",
          kind: "mcp__exa__web_search",
          title: "mcp__exa__web_search",
          status: "completed",
        },
      },
      {
        id: "t2",
        role: "tool",
        text: "Edit notebook",
        tool: { callId: "c2", kind: "edit", title: "Edit notebook" },
        approval: {
          requestId: 3,
          decided: "allow",
          tool: { key: "NotebookEdit", label: "NotebookEdit" },
        },
      },
    ];
    await renderComposer({
      toolAccess: { mcp__docs__read: "never" },
      onToolAccessChange: vi.fn(),
      transcript,
    });
    expect(rows(await openToolAccess()).slice(5)).toEqual([
      {
        name: "docs: read",
        detail: "MCP tool",
        group: "docs: read access",
        choice: "Never",
      },
      {
        name: "exa: web_search",
        detail: "MCP tool",
        group: "exa: web_search access",
        choice: "Ask",
      },
      {
        name: "NotebookEdit",
        detail: "Tool",
        group: "NotebookEdit access",
        choice: "Ask",
      },
    ]);
  });

  it("sets, changes and clears one tool's rule", async () => {
    const onToolAccessChange = vi.fn();
    await renderComposer({ onToolAccessChange });
    let surface = await openToolAccess();
    await act(async () => choose(surface, "Bash", "Always").click());
    expect(onToolAccessChange).toHaveBeenLastCalledWith({ Bash: "always" });

    await renderComposer({
      toolAccess: { Bash: "always" },
      onToolAccessChange,
    });
    surface = popover()!;
    expect(rows(surface)[0]).toMatchObject({ name: "Bash", choice: "Always" });
    await act(async () => choose(surface, "Bash", "Never").click());
    expect(onToolAccessChange).toHaveBeenLastCalledWith({ Bash: "never" });
    await act(async () => choose(surface, "Bash", "Ask").click());
    expect(onToolAccessChange).toHaveBeenLastCalledWith({});
    // Picking the choice that already stands changes nothing.
    onToolAccessChange.mockClear();
    await act(async () => choose(surface, "Bash", "Always").click());
    expect(onToolAccessChange).not.toHaveBeenCalled();
  });

  it("clears every rule with Reset all, which is only there with rules", async () => {
    const reset = () =>
      Array.from(popover()!.querySelectorAll("button")).find(
        (button) => button.textContent === "Reset all",
      );
    const onToolAccessChange = vi.fn();
    await renderComposer({ onToolAccessChange });
    await openToolAccess();
    expect(reset()).toBeUndefined();

    await renderComposer({
      toolAccess: { Bash: "always", "codex:command": "never" },
      onToolAccessChange,
    });
    await act(async () => reset()!.click());
    expect(onToolAccessChange).toHaveBeenLastCalledWith({});
  });

  it("lists Codex's two kinds of request and says what never cannot do", async () => {
    await renderComposer({ harness: "codex", onToolAccessChange: vi.fn() });
    const surface = await openToolAccess();
    expect(rows(surface)).toEqual([
      {
        name: "Commands",
        detail: "Shell commands",
        group: "Commands access",
        choice: "Ask",
      },
      {
        name: "File edits",
        detail: "Patches to files",
        group: "File edits access",
        choice: "Ask",
      },
    ]);
    expect(surface.textContent).toContain(
      "Never declines when Codex asks. Codex runs safe commands without asking.",
    );
    expect(surface.textContent).not.toContain("Always skips plain requests");

    await renderComposer({
      harness: "codex",
      toolAccess: { "codex:command": "always" },
      onToolAccessChange: vi.fn(),
    });
    expect(popover()!.textContent).toContain(
      "Always skips plain requests. Plan turns and requests for more access are not skipped.",
    );
  });

  it("says on Claude Code what a rule in effect does not do", async () => {
    await renderComposer({ onToolAccessChange: vi.fn() });
    const surface = await openToolAccess();
    expect(surface.textContent).not.toContain("plan turns");
    expect(surface.textContent).not.toContain("next turn starts");

    await renderComposer({
      toolAccess: { Bash: "always", WebFetch: "never" },
      onToolAccessChange: vi.fn(),
    });
    expect(popover()!.textContent).toContain(
      "Always is not used in plan turns. They stay read-only.",
    );
    expect(popover()!.textContent).toContain(
      "Never takes the tool away when the next turn starts.",
    );
  });

  it("keeps a rule from another provider in view so it can be cleared", async () => {
    const onToolAccessChange = vi.fn();
    await renderComposer({
      harness: "codex",
      toolAccess: { Bash: "always" },
      onToolAccessChange,
    });
    const surface = await openToolAccess();
    expect(rows(surface).at(-1)).toEqual({
      name: "Bash",
      detail: "Only applies on Claude Code",
      group: "Bash access",
      choice: "Always",
    });
    await act(async () => choose(surface, "Bash", "Ask").click());
    expect(onToolAccessChange).toHaveBeenLastCalledWith({});
  });

  it("closes on Escape and on a click outside", async () => {
    await renderComposer({ onToolAccessChange: vi.fn() });
    await openToolAccess();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(popover()).toBeNull();

    await openToolAccess();
    expect(popover()).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(popover()).toBeNull();
  });

  it("gives way to the plus menu when its button is pressed again", async () => {
    await renderComposer({ onToolAccessChange: vi.fn() });
    await openToolAccess();
    await act(async () => plusButton().click());
    expect(popover()).toBeNull();
    expect(document.body.textContent).toContain("Upload file");
  });

  it("closes when the chat changes provider", async () => {
    await renderComposer({ onToolAccessChange: vi.fn() });
    await openToolAccess();
    await renderComposer({ harness: "codex", onToolAccessChange: vi.fn() });
    expect(popover()).toBeNull();
  });
});

describe("tool rules in a compact composer", () => {
  it("adds the rule count to the summary", async () => {
    await renderComposer({
      compact: true,
      toolAccess: { Bash: "always", WebFetch: "never" },
      onToolAccessChange: vi.fn(),
    });
    const summary = container.querySelector<HTMLElement>(
      "[data-session-tools-summary]",
    );
    expect(summary?.textContent).toBe("2 tool rules");
    expect(summary?.title).toBe("Always allow: Bash\nNever allow: WebFetch");
  });
});
