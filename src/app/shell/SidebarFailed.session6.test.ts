// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { formatSessionTitle } from "../../features/sessions/model/session";
import { Sidebar } from "./Sidebar";

// Mac test 2.16: an automation run that failed at setup read "Done".

vi.mock("../../features/source-control/hooks/useProjectDiffStats", () => ({
  useProjectDiffStats: vi.fn(() => null),
}));
vi.mock("../../features/source-control/hooks/useGitFileStatuses", () => ({
  useGitFileStatuses: () => ({ files: new Map(), dirs: new Map() }),
}));
vi.mock("./SidebarUpdate", () => ({ SidebarUpdateFooter: () => null }));
vi.mock("../../features/files/ui/FileTree", () => ({
  FileTree: () => null,
}));

let container: HTMLDivElement;
let root: Root;
let props: ComponentProps<typeof Sidebar>;

const card = () => container.querySelector('[data-session-card="run-1"]')!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  });
  props = {
    cwd: "/workspace/project",
    open: true,
    sessions: [
      {
        id: "run-1",
        cwd: "/workspace/project",
        harness: "claude",
        model: "",
        runtimeMode: "supervised",
        title: formatSessionTitle("claude", "Weekday tests"),
        automationId: "auto-1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
    busySessionIds: new Set(),
    approvalSessionIds: new Set(),
    activeSessionId: "other",
    unseenFinishedIds: new Set(["run-1"]),
    status: "idle",
    pending: false,
    tab: "sessions",
    filesSearchOpen: false,
    onSelectSession: vi.fn(),
    onOpenFile: vi.fn(),
    onTabChange: vi.fn(),
    onFilesSearchOpenChange: vi.fn(),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shows a finished run as Done", () => {
  act(() => root.render(createElement(Sidebar, props)));
  expect(card().textContent).toContain("Done");
  expect(card().querySelector("[data-session-failed]")).toBeNull();
});

it("shows a run whose turn ended in an error as Failed, with the error", () => {
  props.failedTurnErrors = new Map([["run-1", "fatal: Needed a single revision"]]);
  act(() => root.render(createElement(Sidebar, props)));
  const failed = card().querySelector("[data-session-failed]");
  expect(failed?.textContent).toBe("Failed");
  expect(failed?.getAttribute("title")).toBe("fatal: Needed a single revision");
  expect(card().textContent).not.toContain("Done");
});
