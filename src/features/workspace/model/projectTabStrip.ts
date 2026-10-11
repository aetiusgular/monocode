import { projectKey, projectName } from "../../../shared/lib/paths";
import { sameProjectPath } from "../../projects/model/recents";
import type { Session } from "../../sessions/model/session";
import type { WorkspaceTab } from "./layout";
import {
  planWorkspaceTabClose,
  workspaceTabCwd,
  type WorkspaceTabClosePlan,
} from "./workspaceTabGroups";

/**
 * The title bar's strip when it lists every project's tabs: tabs grouped by
 * project, in the order each project first appears in the flat tab list, with
 * a projectless tab standing on its own where it sits.
 */

/** Where a tab sits in the strip. */
export type ProjectTabPlacement = {
  /** Project folder path, the group identity. */
  projectPath: string;
  projectName: string;
  /** Worktree path when the tab runs outside the main checkout, else null. */
  worktree: string | null;
};

export type ProjectTabGroup = {
  /** `projectKey(path)`: stable across spelling differences of the path. */
  key: string;
  path: string;
  name: string;
  /** Tab ids in strip order. */
  tabIds: string[];
};

export type ProjectTabStrip = {
  /** Every tab in strip order. */
  order: WorkspaceTab[];
  groups: ProjectTabGroup[];
  /** Absent for a tab with no project. */
  placements: Map<string, ProjectTabPlacement>;
};

type StripSlot =
  | { kind: "group"; group: ProjectTabGroup; tabs: WorkspaceTab[] }
  | { kind: "single"; tab: WorkspaceTab };

export function groupTabsByProject(
  tabs: readonly WorkspaceTab[],
  sessions: readonly Session[],
  workspaceOf: (tab: WorkspaceTab) => string | null,
): ProjectTabStrip {
  const slots: StripSlot[] = [];
  const groups: ProjectTabGroup[] = [];
  const placements = new Map<string, ProjectTabPlacement>();

  for (const tab of tabs) {
    const cwd = workspaceTabCwd(tab, sessions);
    if (!cwd) {
      slots.push({ kind: "single", tab });
      continue;
    }
    const workspace = workspaceOf(tab);
    placements.set(tab.id, {
      projectPath: cwd,
      projectName: projectName(cwd),
      worktree:
        workspace && !sameProjectPath(workspace, cwd) ? workspace : null,
    });
    let slot = slots.find(
      (entry): entry is Extract<StripSlot, { kind: "group" }> =>
        entry.kind === "group" && sameProjectPath(entry.group.path, cwd),
    );
    if (!slot) {
      const group: ProjectTabGroup = {
        key: projectKey(cwd),
        path: cwd,
        name: projectName(cwd),
        tabIds: [],
      };
      groups.push(group);
      slot = { kind: "group", group, tabs: [] };
      slots.push(slot);
    }
    slot.group.tabIds.push(tab.id);
    slot.tabs.push(tab);
  }

  return {
    order: slots.flatMap((slot) =>
      slot.kind === "group" ? slot.tabs : [slot.tab],
    ),
    groups,
    placements,
  };
}

/**
 * Tabs the strip shows: a collapsed group keeps only its active tab. Chips,
 * and so folds, only appear once the strip spans two projects.
 */
export function visibleStripTabs(
  strip: ProjectTabStrip,
  collapsed: ReadonlySet<string>,
  activeId: string,
): WorkspaceTab[] {
  if (collapsed.size === 0 || strip.groups.length < 2) return strip.order;
  const hidden = new Set<string>();
  for (const group of strip.groups) {
    if (!collapsed.has(group.key)) continue;
    for (const id of group.tabIds) if (id !== activeId) hidden.add(id);
  }
  return strip.order.filter((tab) => !hidden.has(tab.id));
}

/** The tab after or before the active one in the visible order, wrapping. */
export function nextStripTab<T extends { id: string }>(
  visible: readonly T[],
  activeId: string,
  delta: 1 | -1,
): T | undefined {
  const index = visible.findIndex((tab) => tab.id === activeId);
  if (index < 0 || visible.length === 0) return undefined;
  return visible[(index + delta + visible.length) % visible.length];
}

/** The tab a digit shortcut picks; a negative slot is the last tab. */
export function stripSlotTab<T extends { id: string }>(
  visible: readonly T[],
  slot: number,
): T | undefined {
  return slot < 0 ? visible[visible.length - 1] : visible[slot];
}

/**
 * Items the title bar draws, which already carry the project App grouped them
 * by. A missing path marks a projectless tab.
 */
export type StripItem = { id: string; projectPath?: string };

/** A contiguous run of one project's tabs; a projectless tab is a run of one. */
export type ProjectTabRun = {
  key: string | null;
  path: string | null;
  /** First index in the item list. */
  start: number;
  /** Index past the last item. */
  end: number;
  ids: string[];
};

function runKey(item: StripItem): string | null {
  return item.projectPath ? projectKey(item.projectPath) : null;
}

export function projectTabRuns(items: readonly StripItem[]): ProjectTabRun[] {
  const runs: ProjectTabRun[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const key = runKey(item);
    const last = runs[runs.length - 1];
    if (key && last && last.key === key && last.end === index) {
      last.end = index + 1;
      last.ids.push(item.id);
      continue;
    }
    runs.push({
      key,
      path: item.projectPath ?? null,
      start: index,
      end: index + 1,
      ids: [item.id],
    });
  }
  return runs;
}

/** Runs that stand for a project, in strip order. */
export function projectRunCount(runs: readonly ProjectTabRun[]): number {
  return runs.filter((run) => run.key != null).length;
}

/** Index range (inclusive) a drag of `id` may land in: its own run. */
export function reorderSpan(
  items: readonly StripItem[],
  id: string,
): { start: number; end: number } | undefined {
  const run = projectTabRuns(items).find((entry) => entry.ids.includes(id));
  return run ? { start: run.start, end: run.end - 1 } : undefined;
}

/**
 * Keep a reorder inside the moved tab's run. A drop past the run's span lands
 * at the run's edge; any other tab keeps its place.
 */
export function clampReorderToGroup(
  items: readonly StripItem[],
  orderedIds: readonly string[],
  movedId: string,
): string[] {
  const run = projectTabRuns(items).find((entry) =>
    entry.ids.includes(movedId),
  );
  if (!run) return [...orderedIds];
  const rest = orderedIds.filter((id) => id !== movedId);
  if (rest.length !== orderedIds.length - 1) return [...orderedIds];
  const members = new Set(run.ids.filter((id) => id !== movedId));
  if (members.size === 0) return items.map((item) => item.id);
  let first = -1;
  let last = -1;
  rest.forEach((id, index) => {
    if (!members.has(id)) return;
    if (first < 0) first = index;
    last = index;
  });
  const at = Math.max(first, Math.min(orderedIds.indexOf(movedId), last + 1));
  const next = rest.slice();
  next.splice(at, 0, movedId);
  return next;
}

/** Ids a collapsed run hides: every tab but the active one. */
export function hiddenStripTabIds(
  runs: readonly ProjectTabRun[],
  collapsed: ReadonlySet<string>,
  activeId: string,
): Set<string> {
  const hidden = new Set<string>();
  for (const run of runs) {
    if (!run.key || !collapsed.has(run.key)) continue;
    for (const id of run.ids) if (id !== activeId) hidden.add(id);
  }
  return hidden;
}

/**
 * The tab to land on when a whole run closes: the active tab when it is
 * elsewhere, else the nearest tab outside the run. Undefined when nothing
 * else is open.
 */
export function closeRunFallback(
  orderIds: readonly string[],
  runIds: readonly string[],
  activeId: string,
): string | undefined {
  const closing = new Set(runIds);
  if (activeId && orderIds.includes(activeId) && !closing.has(activeId)) {
    return activeId;
  }
  const first = orderIds.findIndex((id) => closing.has(id));
  if (first < 0) return orderIds.find((id) => !closing.has(id));
  for (let index = first - 1; index >= 0; index -= 1) {
    if (!closing.has(orderIds[index])) return orderIds[index];
  }
  for (let index = first + 1; index < orderIds.length; index += 1) {
    if (!closing.has(orderIds[index])) return orderIds[index];
  }
  return undefined;
}

/**
 * Close plan for the grouped strip: the project's own neighbour first, as the
 * Deck layout does, and when the project has no other tab in that workspace
 * the neighbour in strip order instead of keeping a blank tab.
 */
export function planProjectStripTabClose({
  tabs,
  sessions,
  closingTabId,
  worktreeOf,
}: {
  tabs: WorkspaceTab[];
  sessions: Session[];
  closingTabId: string;
  worktreeOf?: (tab: WorkspaceTab) => string | null;
}): WorkspaceTabClosePlan {
  const closing = tabs.find((tab) => tab.id === closingTabId);
  if (!closing) return { action: "keep" };
  if (workspaceTabCwd(closing, sessions)) {
    const scoped = planWorkspaceTabClose({
      tabs,
      sessions,
      closingTabId,
      scope: "project",
      worktreeOf,
    });
    if (scoped.action === "close") return scoped;
  }
  const order = groupTabsByProject(
    tabs,
    sessions,
    (tab) => worktreeOf?.(tab) ?? null,
  ).order;
  const index = order.findIndex((tab) => tab.id === closingTabId);
  if (index < 0 || order.length < 2) return { action: "keep" };
  const next = order[index - 1] ?? order[index + 1];
  return { action: "close", nextActiveTabId: next.id };
}
