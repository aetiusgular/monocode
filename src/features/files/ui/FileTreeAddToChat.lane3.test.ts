// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listCachedDir } from "../model/fileTree";
import type { FsEntry } from "../../../platform/tauri/fs";
import { ADD_TO_CHAT_EVENT } from "../../sessions/model/quoteDraft";
import { FileTree } from "./FileTree";

const directories = vi.hoisted(() => new Map<string, FsEntry[]>());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, string>) => {
    if (command === "list_dir") return directories.get(args.path) ?? [];
    return [];
  }),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => undefined }),
}));

const cwd = "/lane3-project";
let container: HTMLDivElement;
let root: Root;
let heard: Array<{ text: string; mode: string }>;
const listener = (event: Event) =>
  heard.push((event as CustomEvent<{ text: string; mode: string }>).detail);

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  directories.set(cwd, [
    { name: "my notes.md", path: `${cwd}/my notes.md`, isDir: false, ignored: false },
    { name: "app.ts", path: `${cwd}/app.ts`, isDir: false, ignored: false },
  ]);
  await listCachedDir(cwd);
  heard = [];
  window.addEventListener(ADD_TO_CHAT_EVENT, listener);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  window.removeEventListener(ADD_TO_CHAT_EVENT, listener);
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function addToChat(name: string) {
  await act(async () => root.render(createElement(FileTree, { cwd, onOpenFile: vi.fn() })));
  const row = container.querySelector<HTMLElement>(
    `[role="treeitem"][title="${cwd}/${name}"]`,
  )!;
  await act(async () => {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  const item = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
    (node) => node.textContent?.includes("Add to Chat"),
  );
  expect(item).toBeDefined();
  await act(async () => item!.click());
}

it("adds a file to the chat as an @mention", async () => {
  await addToChat("app.ts");
  expect(heard).toEqual([{ text: "@app.ts", mode: "plain" }]);
});

it("adds a file with a space in its name as a quoted path", async () => {
  await addToChat("my notes.md");
  expect(heard).toEqual([{ text: "`my notes.md`", mode: "plain" }]);
});
