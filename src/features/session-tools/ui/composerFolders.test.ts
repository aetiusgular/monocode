// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openDialog = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/plugin-dialog")>()),
  open: openDialog,
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("../../source-control/hooks/useProjectBranches", () => ({
  useProjectBranchesState: () => ({ branches: undefined, settled: true }),
}));

import { Composer } from "../../sessions/ui/Composer";
import type { HarnessId } from "../../sessions/model/session";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  openDialog.mockReset();
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

async function renderComposer(options: {
  harness?: HarnessId;
  remoteSession?: boolean;
  busy?: boolean;
  extraDirs?: string[];
  onExtraDirsChange?: (dirs: string[]) => void;
  compact?: boolean;
  disabledMcpServers?: string[];
}) {
  await act(async () =>
    root.render(
      createElement(Composer, {
        focused: true,
        harness: options.harness ?? "claude",
        model: "claude-sonnet",
        runtimeMode: "supervised",
        cwd: "/repo",
        executionCwd: "/worktrees/feature",
        hideProjectPicker: true,
        hideBranchPicker: true,
        remoteSession: options.remoteSession,
        busy: options.busy,
        extraDirs: options.extraDirs,
        onExtraDirsChange: options.onExtraDirsChange,
        compact: options.compact,
        disabledMcpServers: options.disabledMcpServers,
        onFocus: () => {},
        onCwdChange: () => {},
        onModelChange: () => {},
        onRuntimeModeChange: () => {},
        onSubmit: () => {},
      }),
    ),
  );
}

async function openPlusMenu() {
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Add files or choose a mode"]',
      )!
      .click(),
  );
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-composer-plus] button"),
  );
}

function addFolderEntry(buttons: HTMLButtonElement[]) {
  return buttons.find((button) => button.textContent?.includes("Add folder"));
}

describe("Add folder in the composer plus menu", () => {
  it.each(["claude", "codex"] as const)(
    "is offered for %s",
    async (harness) => {
      await renderComposer({ harness, onExtraDirsChange: vi.fn() });
      const entry = addFolderEntry(await openPlusMenu());
      expect(entry?.textContent).toContain(
        "Give the agent another folder to work in",
      );
    },
  );

  it.each(["cursor", "opencode", "grok", "fx"] as const)(
    "is not offered for %s",
    async (harness) => {
      await renderComposer({ harness, onExtraDirsChange: vi.fn() });
      expect(addFolderEntry(await openPlusMenu())).toBeUndefined();
    },
  );

  it("is not offered for a host session or without a change handler", async () => {
    await renderComposer({ remoteSession: true, onExtraDirsChange: vi.fn() });
    expect(addFolderEntry(await openPlusMenu())).toBeUndefined();
    await renderComposer({});
    expect(addFolderEntry(await openPlusMenu())).toBeUndefined();
  });

  it("adds picked folders, skipping duplicates and the working directories", async () => {
    const onExtraDirsChange = vi.fn();
    openDialog.mockResolvedValue([
      "/work/docs",
      "/work/design",
      "/repo/packages",
      "/worktrees/feature",
    ]);
    await renderComposer({ extraDirs: ["/work/docs"], onExtraDirsChange });
    const entry = addFolderEntry(await openPlusMenu())!;
    await act(async () => entry.click());

    expect(openDialog).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, multiple: true }),
    );
    expect(onExtraDirsChange).toHaveBeenCalledTimes(1);
    expect(onExtraDirsChange).toHaveBeenCalledWith([
      "/work/docs",
      "/work/design",
    ]);
    // Picking closes the menu.
    expect(document.querySelector("[data-composer-plus]")).toBeNull();
  });

  it("changes nothing when the picker is cancelled or adds nothing new", async () => {
    const onExtraDirsChange = vi.fn();
    openDialog.mockResolvedValueOnce(null);
    await renderComposer({ extraDirs: ["/work/docs"], onExtraDirsChange });
    await act(async () => addFolderEntry(await openPlusMenu())!.click());
    openDialog.mockResolvedValueOnce("/work/docs");
    await act(async () => addFolderEntry(await openPlusMenu())!.click());
    expect(onExtraDirsChange).not.toHaveBeenCalled();
  });
});

describe("extra folder chips", () => {
  const chips = () =>
    Array.from(
      container.querySelectorAll<HTMLElement>(
        '[aria-label="Extra folders"] [role="listitem"]',
      ),
    );

  it("shows each folder by name with its full path as the title", async () => {
    await renderComposer({
      extraDirs: ["/work/docs", "/work/shared assets"],
      onExtraDirsChange: vi.fn(),
    });
    expect(chips().map((chip) => [chip.textContent, chip.title])).toEqual([
      ["docs", "/work/docs"],
      ["shared assets", "/work/shared assets"],
    ]);
  });

  it("removes a folder from its chip", async () => {
    const onExtraDirsChange = vi.fn();
    await renderComposer({
      extraDirs: ["/work/docs", "/work/design"],
      onExtraDirsChange,
    });
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Remove folder docs"]')!
        .click(),
    );
    expect(onExtraDirsChange).toHaveBeenCalledWith(["/work/design"]);
  });

  it("hides the chips where folders cannot be passed on", async () => {
    await renderComposer({
      harness: "cursor",
      extraDirs: ["/work/docs"],
      onExtraDirsChange: vi.fn(),
    });
    expect(chips()).toHaveLength(0);
    await renderComposer({
      remoteSession: true,
      extraDirs: ["/work/docs"],
      onExtraDirsChange: vi.fn(),
    });
    expect(chips()).toHaveLength(0);
  });

  it("marks only a folder added while a turn is running", async () => {
    const onExtraDirsChange = vi.fn();
    await renderComposer({ extraDirs: ["/work/docs"], onExtraDirsChange });
    expect(container.textContent).not.toContain("next turn");

    await renderComposer({
      busy: true,
      extraDirs: ["/work/docs"],
      onExtraDirsChange,
    });
    expect(container.textContent).not.toContain("next turn");

    await renderComposer({
      busy: true,
      extraDirs: ["/work/docs", "/work/design"],
      onExtraDirsChange,
    });
    expect(chips().map((chip) => chip.textContent)).toEqual([
      "docs",
      "designnext turn",
    ]);

    // The next turn starts with both folders, so the note goes away.
    await renderComposer({
      extraDirs: ["/work/docs", "/work/design"],
      onExtraDirsChange,
    });
    expect(container.textContent).not.toContain("next turn");
  });
});

describe("session tools in a compact composer", () => {
  const pill = () =>
    container.querySelector<HTMLElement>("[data-session-tools-summary]");

  it("sums the folders and switched-off connectors up in one pill", async () => {
    await renderComposer({
      compact: true,
      extraDirs: ["/work/docs", "/work/shared assets"],
      onExtraDirsChange: vi.fn(),
      disabledMcpServers: ["github"],
    });
    expect(pill()?.textContent).toBe("2 folders · 1 off");
    expect(pill()?.title).toBe(
      "Extra folders:\n/work/docs\n/work/shared assets\nConnectors off: github",
    );
    // The chips and the badge themselves stay out of the small composer.
    expect(container.querySelector('[aria-label="Extra folders"]')).toBeNull();
    expect(container.querySelector("[data-connectors-badge]")).toBeNull();
  });

  it("shows whatever a turn is sent with, change handlers or not", async () => {
    await renderComposer({ compact: true, extraDirs: ["/work/docs"] });
    expect(pill()?.textContent).toBe("1 folder");
    expect(pill()?.title).toBe("Extra folders:\n/work/docs");

    await renderComposer({
      compact: true,
      harness: "codex",
      disabledMcpServers: ["github", "linear"],
    });
    expect(pill()?.textContent).toBe("2 off");
    expect(pill()?.title).toBe("Connectors off: github, linear");
  });

  it("leaves out a folder the working directory already covers", async () => {
    await renderComposer({
      compact: true,
      extraDirs: ["/worktrees/feature/packages", "/work/docs"],
    });
    expect(pill()?.textContent).toBe("1 folder");
  });

  it("is absent when a turn is sent with neither", async () => {
    await renderComposer({ compact: true });
    expect(pill()).toBeNull();
    await renderComposer({
      compact: true,
      harness: "cursor",
      extraDirs: ["/work/docs"],
      disabledMcpServers: ["github"],
    });
    expect(pill()).toBeNull();
    await renderComposer({
      compact: true,
      remoteSession: true,
      extraDirs: ["/work/docs"],
    });
    expect(pill()).toBeNull();
  });

  it("is absent from the full composer, which has the chips", async () => {
    await renderComposer({
      extraDirs: ["/work/docs"],
      onExtraDirsChange: vi.fn(),
    });
    expect(pill()).toBeNull();
    expect(
      container.querySelector('[aria-label="Extra folders"]'),
    ).not.toBeNull();
  });
});
