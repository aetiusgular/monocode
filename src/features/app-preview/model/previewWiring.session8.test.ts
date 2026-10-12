import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  editorTabKey,
  isAppPreviewTab,
  isFilesystemTab,
  isPreviewableTab,
  isVirtualDocumentTab,
  leafIds,
  newAppPreviewTab,
  newFileTab,
  newTab,
  openEditorTab,
  splitPane,
} from "../../workspace/model/layout";
import { collectWorkspaceSnapshot } from "../../workspace/model/workspaceSnapshot";
import {
  surfaceTabMenuItems,
  surfaceTabPresentation,
} from "../../workspace/ui/SurfaceTabs";
import { privacyView, type PrivacySession } from "../../privacy-view/model/privacyView";
import { PrivacySection } from "../../privacy-view/ui/PrivacySection";
import { turnWroteFiles } from "../../file-cards/model/documentFiles";
import type { Block } from "../../sessions/model/session";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));
afterEach(() => vi.unstubAllGlobals());

describe("the preview tab", () => {
  it("is a live-only virtual tab, one per chat", () => {
    const file = newAppPreviewTab("s1", "/repo");
    expect(isAppPreviewTab(file)).toBe(true);
    expect(isVirtualDocumentTab(file)).toBe(true);
    expect(isFilesystemTab(file)).toBe(false);
    expect(isPreviewableTab(file)).toBe(false);
    expect(editorTabKey(file)).toBe("app-preview:s1");
    expect(editorTabKey(newAppPreviewTab("s1", "/repo"))).toBe(editorTabKey(file));
    expect(isAppPreviewTab(newFileTab("/repo/Preview", "/repo"))).toBe(false);
  });

  it("opens once per chat, and offers no file actions", () => {
    let tab = newTab("s1");
    tab = openEditorTab(tab, newAppPreviewTab("s1", "/repo"));
    tab = openEditorTab(tab, newAppPreviewTab("s1", "/repo"));
    expect(tab.editorPanes.flatMap((pane) => pane.files)).toHaveLength(1);
    const file = tab.editorPanes[0].files[0];
    expect(surfaceTabPresentation(file).label).toBe("Preview");
    expect(
      surfaceTabMenuItems(file).map((item) => (item.kind === "item" ? item.id : "sep")),
    ).toEqual(["close", "close-others"]);
  });

  it("is not saved with the workspace, and its pane goes with it", () => {
    const preview = newAppPreviewTab("s1", "/repo");
    const file = newFileTab("/repo/README.md", "/repo");
    const tab = {
      ...newTab("s1"),
      id: "t1",
      layout: splitPane(newTab("s1").layout, "s1", "right", "e1"),
      editorPanes: [
        { id: "e1", files: [preview], activeFileId: preview.id },
        { id: "e2", files: [file], activeFileId: file.id },
      ],
    };
    const snapshot = collectWorkspaceSnapshot([tab], [], "t1", "/repo", new Map());
    const panes = snapshot.tabs[0]!.editorPanes;
    expect(panes.map((pane) => pane.id)).toEqual(["e2"]);
    expect(JSON.stringify(snapshot)).not.toContain("appPreview");
    expect(leafIds(snapshot.tabs[0]!.layout)).toEqual(["s1"]);
  });
});

describe("the privacy view with a preview running", () => {
  const codex: PrivacySession = {
    harness: "codex",
    runtimeMode: "auto-accept-edits",
    cwd: "/repo",
    blocks: [],
  };

  it("marks a sandboxed chat as not sandboxed and says why", () => {
    expect(privacyView(codex).sandbox.sandboxed).toBe(true);
    const view = privacyView(codex, { previewServer: { command: "npm run dev" } });
    expect(view.sandbox.sandboxed).toBe(false);
    expect(view.sandbox.outside).toContain("npm run dev");
    const html = renderToStaticMarkup(createElement(PrivacySection, { view }));
    expect(html).toContain("data-outside-sandbox");
    expect(html).toContain("full rights");
  });

  it("leaves where data goes unchanged: the server is local", () => {
    const before = privacyView(codex);
    const after = privacyView(codex, { previewServer: { command: "npm run dev" } });
    expect(after.destinations).toEqual(before.destinations);
    expect(after.private).toBe(before.private);
  });
});

describe("turnWroteFiles", () => {
  const tool = (kind: string, status = "completed", extra: Partial<Block> = {}): Block => ({
    id: `${kind}-${status}`,
    role: "tool",
    text: `${kind} src/a.ts`,
    tool: { title: `${kind} src/a.ts`, kind, status },
    ...extra,
  });

  it("counts edits and writes that landed, and nothing else", () => {
    expect(turnWroteFiles([tool("edit")])).toBe(true);
    expect(turnWroteFiles([tool("write")])).toBe(true);
    expect(turnWroteFiles([tool("read")])).toBe(false);
    expect(turnWroteFiles([tool("search")])).toBe(false);
    expect(turnWroteFiles([])).toBe(false);
  });

  it("does not count an edit that was denied", () => {
    const denied = tool("edit", "completed", {
      approval: { id: "a", kind: "edit", decided: "deny" } as Block["approval"],
    });
    expect(turnWroteFiles([denied])).toBe(false);
  });
});
