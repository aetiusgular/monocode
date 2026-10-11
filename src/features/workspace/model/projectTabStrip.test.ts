import { describe, expect, it } from "vitest";
import type { Session } from "../../sessions/model/session";
import { newTab, type WorkspaceTab } from "./layout";
import {
  clampReorderToGroup,
  closeRunFallback,
  groupTabsByProject,
  hiddenStripTabIds,
  nextStripTab,
  planProjectStripTabClose,
  projectRunCount,
  projectTabRuns,
  reorderSpan,
  stripSlotTab,
  visibleStripTabs,
} from "./projectTabStrip";

function session(
  id: string,
  cwd: string,
  extra: Partial<Session> = {},
): Session {
  return {
    id,
    cwd,
    harness: "codex",
    title: "",
    blocks: [],
    busy: false,
    model: "",
    ...extra,
  };
}

function tab(id: string, sessionId = id): WorkspaceTab {
  return { ...newTab(sessionId), id };
}

const sessions = [
  session("a1", "/repos/alpha"),
  session("a2", "/repos/alpha", {
    worktreeCwd: "/repos/alpha-worktrees/feature",
    branch: "feature",
  }),
  session("a3", "/repos/alpha", {
    worktreeCwd: "/repos/alpha-worktrees/feature",
    branch: "feature",
  }),
  session("b1", "/repos/beta"),
  session("home", "~"),
  session("c1", "/repos/gamma"),
];
const workspaceOf = (entry: WorkspaceTab) => {
  const found = sessions.find((item) => item.id === entry.focusedId);
  return found ? (found.worktreeCwd ?? found.cwd) : null;
};
const flat = [tab("a1"), tab("b1"), tab("home"), tab("a2"), tab("c1")];

describe("groupTabsByProject", () => {
  it("orders groups by each project's first tab and keeps tabs in flat order", () => {
    const strip = groupTabsByProject(flat, sessions, workspaceOf);
    expect(strip.order.map((entry) => entry.id)).toEqual([
      "a1",
      "a2",
      "b1",
      "home",
      "c1",
    ]);
    expect(strip.groups.map((group) => [group.name, group.tabIds])).toEqual([
      ["alpha", ["a1", "a2"]],
      ["beta", ["b1"]],
      ["gamma", ["c1"]],
    ]);
    expect(strip.groups[0].path).toBe("/repos/alpha");
  });

  it("leaves a projectless tab ungrouped in place", () => {
    const strip = groupTabsByProject(flat, sessions, workspaceOf);
    expect(strip.placements.has("home")).toBe(false);
    expect(strip.groups.some((group) => group.tabIds.includes("home"))).toBe(
      false,
    );
  });

  it("carries the project and the worktree of a tab outside the main checkout", () => {
    const strip = groupTabsByProject(flat, sessions, workspaceOf);
    expect(strip.placements.get("a1")).toEqual({
      projectPath: "/repos/alpha",
      projectName: "alpha",
      worktree: null,
    });
    expect(strip.placements.get("a2")).toEqual({
      projectPath: "/repos/alpha",
      projectName: "alpha",
      worktree: "/repos/alpha-worktrees/feature",
    });
  });

  it("treats path spellings of one project as the same group", () => {
    const strip = groupTabsByProject(
      [tab("a1"), tab("slash")],
      [...sessions, session("slash", "/repos/alpha/")],
      () => null,
    );
    expect(strip.groups).toHaveLength(1);
    expect(strip.groups[0].tabIds).toEqual(["a1", "slash"]);
  });
});

describe("visibleStripTabs and cycling", () => {
  const strip = groupTabsByProject(flat, sessions, workspaceOf);
  const alphaKey = strip.groups[0].key;

  it("hides a collapsed group's tabs except the active one", () => {
    const visible = visibleStripTabs(strip, new Set([alphaKey]), "a2");
    expect(visible.map((entry) => entry.id)).toEqual([
      "a2",
      "b1",
      "home",
      "c1",
    ]);
    expect(
      visibleStripTabs(strip, new Set([alphaKey]), "b1").map(
        (entry) => entry.id,
      ),
    ).toEqual(["b1", "home", "c1"]);
    expect(visibleStripTabs(strip, new Set(), "b1")).toBe(strip.order);
  });

  it("ignores a saved fold while only one project is open", () => {
    const single = groupTabsByProject(
      [tab("a1"), tab("a2")],
      sessions,
      workspaceOf,
    );
    expect(visibleStripTabs(single, new Set([alphaKey]), "a2")).toBe(
      single.order,
    );
  });

  it("steps next and previous over the visible order, wrapping", () => {
    const visible = visibleStripTabs(strip, new Set([alphaKey]), "b1");
    expect(nextStripTab(visible, "b1", 1)?.id).toBe("home");
    expect(nextStripTab(visible, "b1", -1)?.id).toBe("c1");
    expect(nextStripTab(visible, "c1", 1)?.id).toBe("b1");
    expect(nextStripTab(visible, "a1", 1)).toBeUndefined();
  });

  it("maps digit slots onto the visible order with the last slot at the end", () => {
    const visible = visibleStripTabs(strip, new Set([alphaKey]), "b1");
    expect(stripSlotTab(visible, 0)?.id).toBe("b1");
    expect(stripSlotTab(visible, 2)?.id).toBe("c1");
    expect(stripSlotTab(visible, -1)?.id).toBe("c1");
    expect(stripSlotTab(visible, 9)).toBeUndefined();
  });
});

const items = [
  { id: "a1", projectPath: "/repos/alpha" },
  { id: "a2", projectPath: "/repos/alpha" },
  { id: "b1", projectPath: "/repos/beta" },
  { id: "home" },
  { id: "c1", projectPath: "/repos/gamma" },
  { id: "c2", projectPath: "/repos/gamma" },
];

describe("projectTabRuns", () => {
  it("splits the strip into contiguous project runs and single projectless items", () => {
    const runs = projectTabRuns(items);
    expect(runs.map((run) => [run.path, run.start, run.end, run.ids])).toEqual([
      ["/repos/alpha", 0, 2, ["a1", "a2"]],
      ["/repos/beta", 2, 3, ["b1"]],
      [null, 3, 4, ["home"]],
      ["/repos/gamma", 4, 6, ["c1", "c2"]],
    ]);
    expect(projectRunCount(runs)).toBe(3);
    expect(projectRunCount(projectTabRuns(items.slice(0, 2)))).toBe(1);
  });

  it("keeps two projectless tabs apart", () => {
    const runs = projectTabRuns([{ id: "x" }, { id: "y" }]);
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.key === null)).toBe(true);
  });

  it("hides collapsed runs except the active tab", () => {
    const runs = projectTabRuns(items);
    const gamma = runs[3].key!;
    expect([...hiddenStripTabIds(runs, new Set([gamma]), "c2")]).toEqual([
      "c1",
    ]);
    expect([...hiddenStripTabIds(runs, new Set([gamma]), "a1")]).toEqual([
      "c1",
      "c2",
    ]);
  });
});

describe("reorderSpan and clampReorderToGroup", () => {
  it("spans the moved tab's own run", () => {
    expect(reorderSpan(items, "a2")).toEqual({ start: 0, end: 1 });
    expect(reorderSpan(items, "home")).toEqual({ start: 3, end: 3 });
    expect(reorderSpan(items, "c1")).toEqual({ start: 4, end: 5 });
    expect(reorderSpan(items, "missing")).toBeUndefined();
  });

  it("keeps a reorder that stays inside the run", () => {
    expect(
      clampReorderToGroup(items, ["a2", "a1", "b1", "home", "c1", "c2"], "a2"),
    ).toEqual(["a2", "a1", "b1", "home", "c1", "c2"]);
    expect(
      clampReorderToGroup(items, ["a1", "a2", "b1", "home", "c2", "c1"], "c2"),
    ).toEqual(["a1", "a2", "b1", "home", "c2", "c1"]);
  });

  it("lands a drop past the run's edge at the edge", () => {
    expect(
      clampReorderToGroup(items, ["a2", "b1", "home", "c1", "a1", "c2"], "a1"),
    ).toEqual(["a2", "a1", "b1", "home", "c1", "c2"]);
    expect(
      clampReorderToGroup(items, ["c2", "a1", "a2", "b1", "home", "c1"], "c2"),
    ).toEqual(["a1", "a2", "b1", "home", "c2", "c1"]);
  });

  it("puts a single item back where it was", () => {
    expect(
      clampReorderToGroup(
        items,
        ["a1", "a2", "home", "b1", "c1", "c2"],
        "home",
      ),
    ).toEqual(["a1", "a2", "b1", "home", "c1", "c2"]);
    expect(
      clampReorderToGroup(items, ["b1", "a1", "a2", "home", "c1", "c2"], "b1"),
    ).toEqual(["a1", "a2", "b1", "home", "c1", "c2"]);
  });

  it("passes an unknown or malformed order through", () => {
    expect(clampReorderToGroup(items, ["a1", "a2"], "zzz")).toEqual([
      "a1",
      "a2",
    ]);
    expect(clampReorderToGroup(items, ["a1", "a1", "a2"], "a1")).toEqual([
      "a1",
      "a1",
      "a2",
    ]);
  });
});

describe("closeRunFallback", () => {
  const order = ["a1", "a2", "b1", "home", "c1"];

  it("keeps the active tab when it is outside the run", () => {
    expect(closeRunFallback(order, ["a1", "a2"], "b1")).toBe("b1");
  });

  it("lands on the nearest tab outside the run, preferring the left", () => {
    expect(closeRunFallback(order, ["a1", "a2"], "a1")).toBe("b1");
    expect(closeRunFallback(order, ["b1"], "b1")).toBe("a2");
    expect(closeRunFallback(order, ["c1"], "c1")).toBe("home");
  });

  it("has nothing to land on when the run is every tab", () => {
    expect(closeRunFallback(["a1", "a2"], ["a1", "a2"], "a1")).toBeUndefined();
  });
});

describe("planProjectStripTabClose", () => {
  it("lands on the project's own neighbour while it has one", () => {
    expect(
      planProjectStripTabClose({
        tabs: flat,
        sessions,
        closingTabId: "a2",
        worktreeOf: () => null,
      }),
    ).toEqual({ action: "close", nextActiveTabId: "a1" });
  });

  it("lands on the strip neighbour when the project's last tab closes", () => {
    expect(
      planProjectStripTabClose({
        tabs: flat,
        sessions,
        closingTabId: "b1",
        worktreeOf: () => null,
      }),
    ).toEqual({ action: "close", nextActiveTabId: "a2" });
    expect(
      planProjectStripTabClose({
        tabs: flat,
        sessions,
        closingTabId: "home",
        worktreeOf: () => null,
      }),
    ).toEqual({ action: "close", nextActiveTabId: "b1" });
  });

  it("steps right when the closing tab opens the strip", () => {
    expect(
      planProjectStripTabClose({
        tabs: [tab("b1"), tab("a1")],
        sessions,
        closingTabId: "b1",
        worktreeOf: () => null,
      }),
    ).toEqual({ action: "close", nextActiveTabId: "a1" });
  });

  it("stays with the worktree's own tab before leaving it", () => {
    const plan = planProjectStripTabClose({
      tabs: [tab("a1"), tab("b1"), tab("a2"), tab("a3")],
      sessions,
      closingTabId: "a3",
      worktreeOf: workspaceOf,
    });
    expect(plan).toEqual({ action: "close", nextActiveTabId: "a2" });
  });

  it("keeps the sole tab", () => {
    expect(
      planProjectStripTabClose({
        tabs: [tab("a1")],
        sessions,
        closingTabId: "a1",
      }),
    ).toEqual({ action: "keep" });
    expect(
      planProjectStripTabClose({
        tabs: flat,
        sessions,
        closingTabId: "missing",
      }),
    ).toEqual({ action: "keep" });
  });
});
