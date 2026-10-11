// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCollapsedProjectTabGroups } from "../../features/workspace/model/collapsedProjectTabs";
import { stubHarnesses } from "../../features/workspace/ui/ProjectTabStub";
import { tabCopy, TitleBar, type Tab } from "./TitleBar";

vi.mock("./WindowControls", () => ({ WindowControls: () => null }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  convertFileSrc: (path: string) => path,
}));

const ALPHA = "/repos/alpha";
const BETA = "/repos/beta";
const COLLAPSED_KEY = "monocode:tab-groups:collapsed";

let container: HTMLDivElement;
let root: Root;

function tab(id: string, overrides: Partial<Tab> = {}): Tab {
  return {
    id,
    project: "alpha",
    projectPath: ALPHA,
    title: id,
    more: [],
    sessionCount: 1,
    harnesses: ["codex"],
    busyHarnesses: [],
    doneHarnesses: [],
    files: [],
    ...overrides,
  };
}

const beta = (id: string, overrides: Partial<Tab> = {}) =>
  tab(id, { project: "beta", projectPath: BETA, ...overrides });

type Handlers = {
  onSelect?: ReturnType<typeof vi.fn>;
  onCloseMany?: ReturnType<typeof vi.fn>;
};

function render(
  tabs: Tab[],
  {
    activeId = "a1",
    groupByProject = true,
    handlers = {},
  }: { activeId?: string; groupByProject?: boolean; handlers?: Handlers } = {},
) {
  act(() =>
    root.render(
      createElement(TitleBar, {
        tabs,
        activeId,
        cwd: ALPHA,
        groupByProject,
        onToggleSidebar: vi.fn(),
        onSelect: handlers.onSelect ?? vi.fn(),
        onClose: vi.fn(),
        onCloseMany: handlers.onCloseMany ?? vi.fn(),
        onReorder: vi.fn(),
      }),
    ),
  );
}

const stubs = () =>
  Array.from(
    container.querySelectorAll<HTMLButtonElement>("[data-project-stub]"),
  );
const stub = (key: string) =>
  container.querySelector<HTMLButtonElement>(`[data-project-stub="${key}"]`);
const gaps = () => container.querySelectorAll("[data-project-gap]");
const tabIds = () =>
  Array.from(
    container.querySelectorAll<HTMLElement>("[data-title-tab-id]"),
    (node) => node.dataset.titleTabId,
  );
const tabButton = (id: string) =>
  container.querySelector<HTMLButtonElement>(
    `[data-title-tab-id="${id}"] button`,
  )!;

/** Gaps, stubs and tabs as the strip lays them out, left to right. */
function stripOrder(): string[] {
  const strip = container.querySelector("[data-title-tab-strip]")!;
  return Array.from(
    strip.querySelectorAll<HTMLElement>(
      "[data-project-gap], [data-project-stub], [data-title-tab-id]",
    ),
    (node) =>
      node.dataset.titleTabId ??
      (node.dataset.projectStub ? `stub:${node.dataset.projectStub}` : "gap"),
  );
}

function openContextMenu(target: Element): HTMLElement {
  act(() => {
    target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
  });
  return document.querySelector<HTMLElement>('[role="menu"]')!;
}

// The tab's menu handler sits on the draggable item inside the slot.
const openTabMenu = (id: string) =>
  openContextMenu(
    container.querySelector(`[data-title-tab-id="${id}"] .reorder-item`)!,
  );

function menuLabels(menu: HTMLElement): string[] {
  return Array.from(
    menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    (item) => item.textContent ?? "",
  );
}

function menuItem(menu: HTMLElement, label: string): HTMLButtonElement {
  const item = Array.from(
    menu.querySelectorAll<HTMLButtonElement>("button"),
  ).find((button) => button.textContent?.startsWith(label));
  expect(item).toBeDefined();
  return item!;
}

/** Fold a project from one of its tabs' context menus. */
function foldFromTab(id: string, project: string) {
  // Opened outside the click's act: a nested act would hold the menu back.
  const menu = openTabMenu(id);
  act(() => menuItem(menu, `Collapse ${project}`).click());
}

function click(target: Element, init: MouseEventInit = {}) {
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetCollapsedProjectTabGroups();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  resetCollapsedProjectTabGroups();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("project marks", () => {
  it("shows nothing extra while every tab is in one project", () => {
    render([tab("a1"), tab("a2")]);
    expect(stubs()).toHaveLength(0);
    expect(gaps()).toHaveLength(0);
    expect(container.querySelector("[data-project-tint]")).toBeNull();
    expect(tabIds()).toEqual(["a1", "a2"]);
  });

  it("stays off when grouping is off, even across projects", () => {
    render([tab("a1"), beta("b1")], { groupByProject: false });
    expect(gaps()).toHaveLength(0);
    expect(container.querySelector("[data-project-tint]")).toBeNull();
    expect(menuLabels(openTabMenu("a1"))).not.toContain("Collapse alpha");
  });

  it("tints each project's tabs and leaves a gap before the next project", () => {
    render([tab("a1"), tab("a2"), beta("b1")]);
    expect(stripOrder()).toEqual(["a1", "a2", "gap", "b1"]);
    expect(stubs()).toHaveLength(0);
    const tints = container.querySelectorAll<HTMLElement>(
      "[data-project-tint]",
    );
    expect(tints).toHaveLength(3);
    expect(tints[0].style.background).not.toBe("");
    expect(tints[0].style.background).toBe(tints[1].style.background);
    expect(tints[0].style.background).not.toBe(tints[2].style.background);
    // The project is named in the tab's tooltip, not in the strip.
    expect(tabButton("b1").title.startsWith("beta · ")).toBe(true);
    expect(
      container.querySelector("[data-title-tab-strip]")!.textContent,
    ).not.toContain("beta");
  });

  it("leaves a projectless tab on its own, set off by gaps, without a tint", () => {
    render([
      tab("a1"),
      tab("home", { project: "~", projectPath: undefined }),
      beta("b1"),
    ]);
    expect(stripOrder()).toEqual(["a1", "gap", "home", "gap", "b1"]);
    const home = container.querySelector('[data-title-tab-id="home"]')!;
    expect(home.querySelector("[data-project-tint]")).toBeNull();
    expect(menuLabels(openTabMenu("home")).join("|")).not.toContain("Collapse");
  });

  it("lifts a tab whose reply finished unseen", () => {
    render([tab("a1"), tab("a2", { doneHarnesses: ["codex"] }), beta("b1")]);
    expect(tabButton("a2").className).toContain("text-content/80");
    expect(tabButton("b1").className).toContain("text-content/50");
    expect(tabButton("a2").title).toContain("Response complete");
  });
});

describe("collapsing a project", () => {
  it("folds the group to a stub from a tab's menu, keeps the active tab, and persists", () => {
    render([tab("a1"), tab("a2"), beta("b1"), beta("b2")]);
    const labels = menuLabels(openTabMenu("b1"));
    expect(labels[0]).toMatch(/^Close Tab/);
    expect(labels.slice(1)).toEqual([
      "Close Other Tabs",
      "Close Tabs to the Right",
      "Close Tabs to the Left",
      "Collapse beta",
      "Close beta Tabs2 tabs",
    ]);
    act(() => document.body.click());
    foldFromTab("b1", "beta");

    expect(stripOrder()).toEqual(["a1", "a2", "gap", `stub:${BETA}`]);
    expect(stub(BETA)!.getAttribute("aria-expanded")).toBe("false");
    expect(
      stub(BETA)!.querySelector("[data-project-stub-count]")?.textContent,
    ).toBe("2");
    expect(stub(BETA)!.title).toBe("beta: 2 tabs. Click to expand.");
    expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY)!)).toEqual([BETA]);

    // The active tab stays on screen when its own group folds.
    foldFromTab("a1", "alpha");
    expect(stripOrder()).toEqual([
      `stub:${ALPHA}`,
      "a1",
      "gap",
      `stub:${BETA}`,
    ]);
    expect(
      stub(ALPHA)!.querySelector("[data-project-stub-count]")?.textContent,
    ).toBe("2");

    click(stub(BETA)!);
    expect(stub(BETA)).toBeNull();
    expect(tabIds()).toEqual(["a1", "b1", "b2"]);
    expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY)!)).toEqual([ALPHA]);
  });

  it("folds with an option-click on any of the project's tabs", () => {
    const onSelect = vi.fn();
    render([tab("a1"), beta("b1"), beta("b2")], { handlers: { onSelect } });
    click(tabButton("b2"), { altKey: true });
    expect(onSelect).not.toHaveBeenCalled();
    expect(stub(BETA)).not.toBeNull();
    expect(tabIds()).toEqual(["a1"]);

    click(tabButton("a1"));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("a1");
  });

  it("starts folded from what was saved, the active tab's own group included", () => {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([ALPHA, BETA]));
    render([tab("a1"), tab("a2"), beta("b1"), beta("b2")]);
    expect(stripOrder()).toEqual([
      `stub:${ALPHA}`,
      "a1",
      "gap",
      `stub:${BETA}`,
    ]);
    expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY)!)).toEqual([
      ALPHA,
      BETA,
    ]);
  });

  it("unfolds a group when one of its tabs becomes active", () => {
    const tabs = [tab("a1"), beta("b1"), beta("b2")];
    render(tabs);
    foldFromTab("b1", "beta");
    expect(tabIds()).toEqual(["a1"]);

    render(tabs, { activeId: "b2" });
    expect(stub(BETA)).toBeNull();
    expect(tabIds()).toEqual(["a1", "b1", "b2"]);
    expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY)!)).toEqual([]);
  });

  it("uses the project's saved label in the menu and on the stub", () => {
    localStorage.setItem("monocode:tab-group:key-version", "2");
    localStorage.setItem(
      "monocode:tab-group:labels",
      JSON.stringify({ [BETA]: "Beta app" }),
    );
    render([tab("a1"), beta("b1")]);
    foldFromTab("b1", "Beta app");
    expect(stub(BETA)!.getAttribute("aria-label")).toBe(
      "Expand Beta app, 1 tab",
    );
  });
});

describe("the stub", () => {
  it("shows the harnesses its tabs run on, a spinner while one works, and a check once one finished", () => {
    render([
      tab("a1"),
      beta("b1", { harnesses: ["claude"], busyHarnesses: ["claude"] }),
      beta("b2", { harnesses: ["codex"], doneHarnesses: ["codex"] }),
      beta("b3", { harnesses: ["codex"] }),
    ]);
    foldFromTab("b1", "beta");
    const folded = stub(BETA)!;
    expect(folded.dataset.projectBusy).toBe("true");
    expect(folded.dataset.projectDone).toBe("true");
    expect(folded.querySelector("[data-project-stub-done]")).not.toBeNull();
    expect(folded.title).toBe(
      "beta: 3 tabs, working, one finished. Click to expand.",
    );
    expect(folded.getAttribute("aria-label")).toBe(
      "Expand beta, 3 tabs, working, one finished",
    );

    // Idle: the harness icons stand in for the spinner.
    render([tab("a1"), beta("b1", { harnesses: ["claude"] }), beta("b2")]);
    const idle = stub(BETA)!;
    expect(idle.dataset.projectBusy).toBeUndefined();
    expect(idle.dataset.projectDone).toBeUndefined();
    // Claude and Codex logos are images; the strip shows one per harness.
    expect(idle.querySelectorAll("img, svg")).toHaveLength(2);
    expect(idle.title).toBe("beta: 2 tabs. Click to expand.");
  });

  it("lists each harness once, in the order the tabs use them", () => {
    expect(
      stubHarnesses([
        { harnesses: ["codex", "claude"] },
        { harnesses: ["claude"] },
        { harnesses: ["cursor", "codex"] },
      ]),
    ).toEqual(["codex", "claude", "cursor"]);
    expect(stubHarnesses([])).toEqual([]);
  });

  it("closes the project's tabs from its menu, landing outside the group", () => {
    const onCloseMany = vi.fn();
    render([tab("a1"), tab("a2"), beta("b1")], { handlers: { onCloseMany } });
    foldFromTab("a2", "alpha");
    const menu = openContextMenu(stub(ALPHA)!);
    expect(menu.getAttribute("aria-label")).toBe("Project actions for alpha");
    expect(menuLabels(menu)).toEqual([
      "Expand alpha",
      "Close alpha Tabs2 tabs",
    ]);

    act(() => menuItem(menu, "Close alpha Tabs").click());
    expect(onCloseMany).toHaveBeenCalledExactlyOnceWith(["a1", "a2"], "b1");
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("expands from its menu", () => {
    render([tab("a1"), beta("b1")]);
    foldFromTab("b1", "beta");
    const menu = openContextMenu(stub(BETA)!);
    act(() => menuItem(menu, "Expand beta").click());
    expect(stub(BETA)).toBeNull();
    expect(tabIds()).toEqual(["a1", "b1"]);
  });

  it("opens its menu from the keyboard", () => {
    render([tab("a1"), beta("b1")]);
    foldFromTab("b1", "beta");
    act(() => {
      stub(BETA)!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "F10",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });
});

describe("worktree tabs", () => {
  it("names the branch on the second line and in the tooltip", () => {
    const copy = tabCopy(
      tab("a2", {
        title: "Fix the build",
        worktree: "feature-x",
        sessionCount: 2,
      }),
    );
    expect(copy.headline).toBe("Fix the build");
    expect(copy.meta).toBe("feature-x · 2 sessions");
    expect(copy.tooltip).toBe("alpha · feature-x · Fix the build");
    expect(tabCopy(tab("a1", { title: "Main" })).meta).toBe("");
  });

  it("renders the branch under the title", () => {
    render([tab("a1"), tab("a2", { worktree: "feature-x" }), beta("b1")]);
    const worktreeTab = container.querySelector('[data-title-tab-id="a2"]')!;
    expect(worktreeTab.textContent).toContain("feature-x");
    expect(
      container.querySelector('[data-title-tab-id="a1"]')!.textContent,
    ).not.toContain("feature-x");
  });
});
