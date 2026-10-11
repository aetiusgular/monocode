import {
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  DashboardSquare,
  Inbox,
  PanelLeft,
  PanelRightToggle,
  Settings,
  StickyNote,
  Terminal,
  X,
} from "../../shared/ui/icons";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { basename } from "../../platform/tauri/fs";
import { looksLikeProject } from "../../features/projects/model/recents";
import type { HarnessId } from "../../features/sessions/model/session";
import { CwdPicker } from "../../features/projects/ui/CwdPicker";
import { SessionPanelSlot } from "../../features/session-panel";
import { useLockOverscroll } from "../../shared/hooks/useLockOverscroll";
import {
  useAnimatedReorder,
  type ReorderExternalDrop,
} from "../../shared/hooks/useAnimatedReorder";
import { useTabCloseMotion } from "../../features/workspace/hooks/useTabCloseMotion";
import { TabWidthMotion } from "./ClosingTab";
import { FileTypeIcon } from "../../features/files/ui/FileTypeIcon";
import { HarnessIcon } from "../../features/sessions/ui/HarnessIcon";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TerminalSpinner } from "../../features/sessions/ui/TerminalSpinner";
import { TabLabel } from "../../shared/ui/TabLabel";
import { WindowControls } from "./WindowControls";
import { PixelMascot } from "../../features/projects/ui/PixelMascot";
import {
  MONO_STATUS_LABEL,
  type MonoLook,
  type MonoState,
} from "../../features/monos/model/mono";
import { IS_MAC, IS_WIN, MOD, SHIFT } from "../../platform/tauri/platform";
import type { RecentProject } from "../../features/projects/model/recents";
import {
  ExplorerMenu,
  type ExplorerMenuItem,
} from "../../features/files/ui/ExplorerMenu";
import {
  paneDropFromPoint,
  setExternalPaneDrop,
  useExternalTitleTabDrop,
} from "../../features/workspace/model/paneDrop";
import type { PaneEdge } from "../../features/workspace/model/layout";
import {
  clampReorderToGroup,
  closeRunFallback,
  hiddenStripTabIds,
  projectRunCount,
  projectTabRuns,
  reorderSpan,
  type ProjectTabRun,
} from "../../features/workspace/model/projectTabStrip";
import {
  setProjectTabGroupCollapsed,
  toggleProjectTabGroup,
  useCollapsedProjectTabGroups,
} from "../../features/workspace/model/collapsedProjectTabs";
import {
  ProjectTabGap,
  ProjectTabMark,
  ProjectTabStub,
  stubHarnesses,
  useProjectTabLook,
} from "../../features/workspace/ui/ProjectTabStub";

export type Tab = {
  id: string;
  /** Project folder name, e.g. `agent-terminal`. */
  project: string;
  /** Focused conversation title; empty for a fresh session. */
  title: string;
  /** Other conversation titles in this tab, focused session omitted. */
  more: string[];
  sessionCount: number;
  harnesses: HarnessId[];
  /** Harnesses with an in-flight turn in this tab. */
  busyHarnesses: HarnessId[];
  /** Harnesses with a finished response that has not been focused yet. */
  doneHarnesses?: HarnessId[];
  /** Open file basenames, active files first. */
  files: string[];
  /** Split layout with more than one pane in this tab. */
  multiPane?: boolean;
  /** Focus is on a file/terminal pane rather than a conversation pane. */
  fileFocused?: boolean;
  /** The sole pane is a fresh conversation with no user turn or open file. */
  blank?: boolean;
  /** Explicit tab group; absent means ungrouped. */
  groupId?: string;
  dirty?: boolean;
  terminal?: boolean;
  /** File id when the whole tab is one preview file; double-click pins it. */
  previewFileId?: string;
  /** Project folder path; the strip groups tabs by it when asked to. */
  projectPath?: string;
  /** Branch or folder of the worktree the tab runs in, outside the main checkout. */
  worktree?: string;
};

type Props = {
  tabs: Tab[];
  activeId: string;
  cwd: string;
  /**
   * Mark each project's run of tabs with its colour and a gap once tabs span
   * projects, and let a run fold to a stub.
   */
  groupByProject?: boolean;
  /**
   * The Mono filling the main area. It takes the tabs' place, and nothing
   * project-scoped belongs beside it.
   */
  mono?: { look: MonoLook; state: MonoState };
  onShowMonoDetails?: () => void;
  /** The full-height Mono details panel owns these while it is open. */
  hideWindowControls?: boolean;
  projectRailOpen?: boolean;
  sessionSidebarOpen?: boolean;
  compactRail?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onToggleSidebar: () => void;
  onToggleSessionSidebar?: () => void;
  onSelect: (id: string) => void;
  onNewTerminal?: () => void;
  onOpenSettings?: () => void;
  onOpenInbox?: () => void;
  onOpenNotes?: () => void;
  onClose: (id: string) => void;
  onCloseMany: (ids: string[], fallbackId: string) => void;
  onArchiveTab?: (id: string) => void;
  onDeleteTab?: (id: string) => void;
  onReorder: (ids: string[], movedId?: string) => void;
  onPlaceOnPane?: (tabId: string, targetId: string, edge: PaneEdge) => void;
  onPinFile?: (fileId: string) => void;
  recents?: RecentProject[];
  onSelectProject?: (path: string) => void;
};

const NO_HIDDEN_TABS: ReadonlySet<string> = new Set();

function sessionMeta(tab: Tab): string {
  if (tab.more.length === 1) return tab.more[0];
  if (tab.sessionCount > 1) return `${tab.sessionCount} sessions`;
  return "";
}

export function tabCopy(tab: Tab): {
  headline: string;
  meta: string;
  tooltip: string;
} {
  const project = tab.project.trim() || "~";
  const conversation = tab.title.trim();
  const file = tab.files[0] ?? "";
  const sessions = sessionMeta(tab);
  const untitled = "New session";

  let headline: string;
  const metaParts: string[] = [];

  if (tab.multiPane) {
    if (tab.fileFocused && file) {
      headline = file;
      if (conversation) metaParts.push(conversation);
      else if (sessions) metaParts.push(sessions);
    } else if (conversation) {
      headline = conversation;
      if (file) metaParts.push(file);
      else if (sessions) metaParts.push(sessions);
    } else if (file) {
      headline = file;
      if (sessions) metaParts.push(sessions);
    } else {
      headline = untitled;
      if (sessions) metaParts.push(sessions);
    }
  } else {
    headline = conversation || file || untitled;
    if (sessions) metaParts.push(sessions);
  }

  // A worktree tab names its branch first: "feature-x · 2 sessions".
  if (tab.worktree) metaParts.unshift(tab.worktree);
  const meta = metaParts.join(" · ");

  const tooltipParts = [project];
  if (tab.worktree) tooltipParts.push(tab.worktree);
  if (conversation) tooltipParts.push(conversation);
  tooltipParts.push(...tab.more);
  if (tab.files.length > 0) tooltipParts.push(tab.files.join(", "));
  if (tab.dirty) tooltipParts.push("Unsaved changes");

  return { headline, meta, tooltip: tooltipParts.join(" · ") };
}

/** Which tab-strip edges still have overflow to scroll toward. */
export function tabStripOverflow(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): { left: boolean; right: boolean } {
  const maxScroll = scrollWidth - clientWidth;
  if (maxScroll <= 1) return { left: false, right: false };
  return {
    left: scrollLeft > 1,
    right: scrollLeft < maxScroll - 1,
  };
}

export function titleTabClosable(tab: Tab, tabCount: number): boolean {
  return tabCount > 1 || !tab.blank;
}

export type TitleTabContextAction = "others" | "right" | "left";

/** Tab ids affected by a context-menu action relative to its clicked tab. */
export function titleTabContextCloseIds(
  tabs: readonly Tab[],
  targetId: string,
  action: TitleTabContextAction,
): string[] {
  const targetIndex = tabs.findIndex((tab) => tab.id === targetId);
  if (targetIndex < 0) return [];
  if (action === "left") {
    return tabs.slice(0, targetIndex).map((tab) => tab.id);
  }
  if (action === "right") {
    return tabs.slice(targetIndex + 1).map((tab) => tab.id);
  }
  return tabs.filter((tab) => tab.id !== targetId).map((tab) => tab.id);
}

function TabHarnesses({
  harnesses,
  busyHarnesses,
  doneHarnesses,
  dimmed,
}: {
  harnesses: HarnessId[];
  busyHarnesses: HarnessId[];
  doneHarnesses: HarnessId[];
  dimmed: boolean;
}) {
  const shown = harnesses.slice(0, 3);
  const extra = harnesses.length - shown.length;
  const opacity = dimmed ? "opacity-55" : "opacity-100";
  const busy = new Set(busyHarnesses);
  const done = new Set(doneHarnesses);

  return (
    <span className="flex shrink-0 items-center">
      {shown.map((harness, i) => {
        const status = busy.has(harness)
          ? "busy"
          : done.has(harness)
            ? "done"
            : "idle";
        return (
          <span
            key={harness}
            data-harness-status={status}
            className={`grid size-3.5 shrink-0 place-items-center ${
              status === "done" ? "opacity-100" : opacity
            } ${i > 0 ? "-ml-0.5" : ""}`}
          >
            {status === "busy" ? (
              <TerminalSpinner className="inline-block w-3.5 select-none text-center text-[11px] leading-none text-accent" />
            ) : status === "done" ? (
              <CheckCircle
                className="size-3.5 shrink-0 text-teal-400"
                strokeWidth={2}
              />
            ) : (
              <HarnessIcon harness={harness} className="size-3.5 shrink-0" />
            )}
          </span>
        );
      })}
      {extra > 0 ? (
        <span
          className={`pl-0.5 text-[10px] leading-none ${dimmed ? "text-content/50" : "text-content"}`}
        >
          +{extra}
        </span>
      ) : null}
    </span>
  );
}

type SortableApi = ReturnType<typeof useAnimatedReorder>;

function TitleTabItem({
  tab,
  active,
  closable,
  canDrag,
  sortable,
  tint,
  onSelect,
  onClose,
  onPinFile,
  onContextMenu,
  onFoldProject,
  itemRef,
}: {
  tab: Tab;
  active: boolean;
  closable: boolean;
  canDrag: boolean;
  sortable: SortableApi;
  /** Project color marking the tab as part of a group. */
  tint?: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onPinFile?: (fileId: string) => void;
  onContextMenu: (id: string, event: ReactMouseEvent<HTMLDivElement>) => void;
  /** ⌥-click folds the tab's project instead of selecting the tab. */
  onFoldProject?: () => void;
  itemRef?: (el: HTMLDivElement | null) => void;
}) {
  const { headline, meta, tooltip } = tabCopy(tab);
  const fileIcon = tab.files[0];
  const done = (tab.doneHarnesses?.length ?? 0) > 0;
  const accessibleTooltip = done ? `${tooltip} · Response complete` : tooltip;

  return (
    <div
      ref={(el) => {
        sortable.setItemRef(tab.id, el);
        itemRef?.(el);
      }}
      className="reorder-item tab-motion group @container relative flex h-full cursor-default touch-none items-center self-stretch min-w-0 w-full"
      data-tauri-drag-region="false"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(tab.id, event);
      }}
      onMouseDownCapture={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1 || !closable) return;
        event.preventDefault();
        event.stopPropagation();
        onClose(tab.id);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) {
          return;
        }
        if (canDrag) sortable.onItemPointerDown(tab.id, event);
      }}
    >
      <button
        type="button"
        title={accessibleTooltip}
        aria-label={accessibleTooltip}
        data-tauri-drag-region="false"
        onClick={(event) => {
          if (sortable.consumeClick()) return;
          if (event.altKey && onFoldProject) {
            onFoldProject();
            return;
          }
          onSelect(tab.id);
        }}
        onDoubleClick={() => {
          if (tab.previewFileId) onPinFile?.(tab.previewFileId);
        }}
        // A finished, unseen reply lifts the title so it reads from afar.
        className={`relative flex h-7.5 min-w-0 flex-1 cursor-default items-center gap-1.5 self-center rounded-md px-2 text-left ${
          closable ? "pr-7" : "pr-2.5"
        } ${
          active
            ? "bg-selection text-content"
            : done
              ? "text-content/80 hover:bg-content/5 hover:text-content"
              : "text-content/50 hover:bg-content/5 hover:text-content"
        }`}
      >
        {tab.harnesses.length > 0 ? (
          <TabHarnesses
            harnesses={tab.harnesses}
            busyHarnesses={tab.busyHarnesses}
            doneHarnesses={tab.doneHarnesses ?? []}
            dimmed={!active}
          />
        ) : tab.terminal || !fileIcon ? (
          <Terminal
            className={`size-3.5 shrink-0 ${
              active ? "text-content" : "text-content/55"
            }`}
            strokeWidth={1.75}
          />
        ) : (
          <span className={!active ? "opacity-55" : undefined}>
            <FileTypeIcon name={fileIcon} isDir={false} size={14} />
          </span>
        )}
        {/* Keep two-line tabs compact while leaving room for descenders. */}
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          <span className="flex min-w-0 items-center gap-1">
            <TabLabel
              className={`leading-tight ${tab.previewFileId ? "italic" : ""} ${
                meta
                  ? "text-[13px] @min-[11rem]:text-[10px] @min-[11rem]:font-medium"
                  : "text-[13px]"
              }`}
            >
              {headline}
            </TabLabel>
            {tab.dirty ? (
              <span
                className="size-1.5 shrink-0 rounded-full bg-content/70"
                title="Unsaved changes"
                aria-label="Unsaved changes"
              />
            ) : null}
          </span>
          {meta ? (
            <TabLabel className="hidden text-[10px] leading-tight text-content/45 @min-[11rem]:block">
              {meta}
            </TabLabel>
          ) : null}
        </span>
      </button>
      {closable ? (
        <button
          type="button"
          title="Close Tab"
          aria-label={`Close ${headline}`}
          data-no-drag
          data-tauri-drag-region="false"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose(tab.id);
          }}
          className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-content/50 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100"
        >
          <X className="size-3" strokeWidth={1.75} />
        </button>
      ) : null}
      {tint ? <ProjectTabMark color={tint} /> : null}
    </div>
  );
}

function TabStripChevron({
  side,
  onClick,
}: {
  side: "left" | "right";
  onClick: () => void;
}) {
  const label = side === "left" ? "Scroll tabs left" : "Scroll tabs right";
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-tauri-drag-region="false"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
      className={`absolute top-1/2 z-40 grid size-6.5 -translate-y-1/2 place-items-center rounded-md bg-content/10 backdrop-blur-xl text-content/70 hover:bg-content/15 hover:text-content ${
        side === "left" ? "left-1" : "right-1"
      }`}
    >
      <Icon className="size-3.5" strokeWidth={1.75} />
    </button>
  );
}

export function IconButton({
  label,
  active,
  accent,
  disabled,
  onClick,
  onOpenContextMenu,
  children,
}: {
  label: string;
  active?: boolean;
  accent?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  onOpenContextMenu?: (x: number, y: number) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active || accent}
      aria-disabled={disabled}
      data-tauri-drag-region="false"
      onClick={() => {
        if (disabled) return;
        onClick?.();
      }}
      onContextMenu={
        onOpenContextMenu
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              if (disabled) return;
              event.currentTarget.focus();
              onOpenContextMenu(event.clientX, event.clientY);
            }
          : undefined
      }
      onKeyDown={
        onOpenContextMenu
          ? (event) => {
              if (
                event.key !== "ContextMenu" &&
                !(event.shiftKey && event.key === "F10")
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              if (disabled) return;
              event.currentTarget.focus();
              const rect = event.currentTarget.getBoundingClientRect();
              onOpenContextMenu(rect.left, rect.bottom);
            }
          : undefined
      }
      className={`grid size-6.5 place-items-center rounded-md ${
        disabled
          ? "text-content/25"
          : accent
            ? "text-accent hover:bg-content/10"
            : active
              ? "text-content hover:bg-content/10"
              : "text-content/50 hover:bg-content/10 hover:text-content"
      }`}
    >
      {children}
    </button>
  );
}

export function DevModeLabel() {
  if (!import.meta.env.DEV) return null;
  return (
    <span
      title="Development build"
      className="mr-1 min-w-0 truncate rounded-md bg-skill/15 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-skill"
    >
      Development
    </span>
  );
}

/** Flex spacer that keeps the Development badge next to the visit arrows. */
export function DevModeSlot() {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-end">
      <DevModeLabel />
    </div>
  );
}

export function TabVisitNav({
  canGoBack = false,
  canGoForward = false,
  onGoBack,
  onGoForward,
  onTogglePanel,
  panelActive = false,
  panelLabel = "Toggle Projects",
}: {
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onTogglePanel?: () => void;
  panelActive?: boolean;
  panelLabel?: string;
}) {
  return (
    <div className="flex shrink-0 items-center">
      <IconButton
        label={`Back (${MOD}[)`}
        disabled={!canGoBack}
        onClick={onGoBack}
      >
        <ChevronLeft className="size-3.5" strokeWidth={1.75} />
      </IconButton>
      <IconButton
        label={`Forward (${MOD}])`}
        disabled={!canGoForward}
        onClick={onGoForward}
      >
        <ChevronRight className="size-3.5" strokeWidth={1.75} />
      </IconButton>
      {onTogglePanel ? (
        <IconButton
          label={panelLabel}
          active={panelActive}
          onClick={onTogglePanel}
        >
          <PanelLeft className="size-3.5" strokeWidth={1.75} />
        </IconButton>
      ) : null}
    </div>
  );
}

/** Back + rail toggle for overlay surfaces when the project rail is closed. */
export function OverlayNav({
  onBack,
  onToggleSidebar,
}: {
  onBack?: () => void;
  onToggleSidebar?: () => void;
}) {
  if (!onBack && !onToggleSidebar) return null;
  return (
    <div className="flex shrink-0 items-center px-1.5">
      {onBack ? (
        <IconButton label={`Back (${MOD}[)`} onClick={onBack}>
          <ChevronLeft className="size-3.5" strokeWidth={1.75} />
        </IconButton>
      ) : null}
      {onToggleSidebar ? (
        <IconButton
          label={`Toggle Sidebar (${MOD}B)`}
          onClick={onToggleSidebar}
        >
          <PanelLeft className="size-3.5" strokeWidth={1.75} />
        </IconButton>
      ) : null}
    </div>
  );
}

function TitleBarComponent({
  tabs,
  activeId,
  cwd,
  groupByProject = false,
  mono,
  onShowMonoDetails,
  hideWindowControls = false,
  projectRailOpen = true,
  sessionSidebarOpen = true,
  compactRail = false,
  canGoBack = false,
  canGoForward = false,
  onGoBack,
  onGoForward,
  onToggleSidebar,
  onToggleSessionSidebar,
  onSelect,
  onNewTerminal,
  onOpenSettings,
  onOpenInbox,
  onOpenNotes,
  onClose,
  onCloseMany,
  onArchiveTab,
  onDeleteTab,
  onReorder,
  onPlaceOnPane,
  onPinFile,
  recents = [],
  onSelectProject,
}: Props) {
  const { displayed, setTabNode, finishMotion } = useTabCloseMotion(tabs);
  const collapsedGroups = useCollapsedProjectTabGroups();
  const lookOf = useProjectTabLook();
  // Runs follow what is drawn, closing tabs included, so a chip stays put
  // while its last tab animates out.
  const runs = useMemo(
    () =>
      groupByProject
        ? projectTabRuns(displayed.map((entry) => entry.item))
        : null,
    [displayed, groupByProject],
  );
  // Tints, gaps and folds wait until the strip spans projects; one project
  // looks the way it always did.
  const grouped = runs != null && projectRunCount(runs) > 1;
  const hiddenIds = useMemo(
    () =>
      grouped && runs
        ? hiddenStripTabIds(runs, collapsedGroups, activeId)
        : NO_HIDDEN_TABS,
    [activeId, collapsedGroups, grouped, runs],
  );
  const stripItems = useMemo(
    () =>
      tabs
        .filter((tab) => !hiddenIds.has(tab.id))
        .map((tab) => ({ id: tab.id, projectPath: tab.projectPath })),
    [hiddenIds, tabs],
  );
  const tabIds = useMemo(() => stripItems.map((item) => item.id), [stripItems]);
  // A drag stays inside its project's run; the clamp backs the span up.
  const reorderWithinRun = useCallback(
    (ids: string[], movedId: string) =>
      onReorder(
        groupByProject ? clampReorderToGroup(stripItems, ids, movedId) : ids,
        movedId,
      ),
    [groupByProject, onReorder, stripItems],
  );
  const runSpan = useMemo(
    () =>
      groupByProject ? (id: string) => reorderSpan(stripItems, id) : undefined,
    [groupByProject, stripItems],
  );
  const externalTabDrop = useMemo<ReorderExternalDrop<string> | undefined>(
    () =>
      onPlaceOnPane
        ? {
            onMove: (tabId, event) => {
              if (tabId === activeId) {
                setExternalPaneDrop(null);
                return false;
              }
              const over = paneDropFromPoint(event.clientX, event.clientY);
              setExternalPaneDrop({
                fromId: tabId,
                overId: over?.id ?? null,
                edge: over?.edge ?? "left",
              });
              return over != null;
            },
            onDrop: (tabId, event) => {
              if (tabId === activeId) return false;
              const over = paneDropFromPoint(event.clientX, event.clientY);
              if (!over) return false;
              onPlaceOnPane(tabId, over.id, over.edge);
              return true;
            },
            onEnd: () => setExternalPaneDrop(null),
          }
        : undefined,
    [activeId, onPlaceOnPane],
  );
  const sortable = useAnimatedReorder(
    tabIds,
    reorderWithinRun,
    "x",
    externalTabDrop,
    runSpan,
  );
  const paneToTabDrop = useExternalTitleTabDrop();
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const setTabStripRef = useCallback(
    (el: HTMLDivElement | null) => {
      tabStripRef.current = el;
      lockOverscroll(el);
    },
    [lockOverscroll],
  );
  const [tabOverflow, setTabOverflow] = useState({ left: false, right: false });
  const [tabMenu, setTabMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);
  const [stubMenu, setStubMenu] = useState<{
    key: string;
    x: number;
    y: number;
    trigger: HTMLElement | null;
  } | null>(null);
  const syncTabOverflow = useCallback(() => {
    const el = tabStripRef.current;
    const next = el
      ? tabStripOverflow(el.scrollLeft, el.clientWidth, el.scrollWidth)
      : { left: false, right: false };
    setTabOverflow((prev) =>
      prev.left === next.left && prev.right === next.right ? prev : next,
    );
  }, []);
  const scrollTabsBy = useCallback((direction: -1 | 1) => {
    const el = tabStripRef.current;
    if (!el) return;
    const amount = Math.max(el.clientWidth * 0.6, 112);
    el.scrollBy({ left: direction * amount, behavior: "smooth" });
  }, []);
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const canDrag = tabIds.length > 1;

  useEffect(() => {
    if (sortable.draggingId) return;
    activeTabRef.current?.scrollIntoView({
      inline: "nearest",
      block: "nearest",
    });
  }, [activeId, sortable.draggingId]);

  // Landing on a tab unfolds its group, however the tab was reached. Only a
  // change of tab does this, so the active group can still be folded by hand
  // and a saved fold survives a launch.
  const runsRef = useRef(runs);
  runsRef.current = grouped ? runs : null;
  const unfoldedFor = useRef(activeId);
  useEffect(() => {
    if (unfoldedFor.current === activeId) return;
    unfoldedFor.current = activeId;
    const run = runsRef.current?.find((entry) => entry.ids.includes(activeId));
    if (run?.key) setProjectTabGroupCollapsed(run.key, false);
  }, [activeId]);

  useLayoutEffect(() => {
    const el = tabStripRef.current;
    if (!el) return;
    syncTabOverflow();
    el.addEventListener("scroll", syncTabOverflow, { passive: true });
    const ro = new ResizeObserver(syncTabOverflow);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", syncTabOverflow);
      ro.disconnect();
    };
  }, [syncTabOverflow]);

  useLayoutEffect(() => {
    syncTabOverflow();
  }, [activeId, collapsedGroups, syncTabOverflow, tabs]);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeId),
    [activeId, tabs],
  );
  const systemTitle = useMemo(() => {
    const activeName = activeTab
      ? activeTab.files[0]
        ? basename(activeTab.files[0])
        : activeTab.project
      : "";
    const project = cwd ? basename(cwd) : "";
    if (activeName && project && activeName !== project) {
      return `${activeName} — ${project} — MonoCode`;
    }
    if (project) {
      return `${project} — MonoCode`;
    }
    return "MonoCode";
  }, [activeTab, cwd]);

  useEffect(() => {
    document.title = systemTitle;
    try {
      void getCurrentWindow().setTitle(systemTitle);
    } catch {}
  }, [systemTitle]);

  /**
   * The project a run belongs to, with what its menu entries need: the tabs
   * still open in it, where closing them all lands, and whether it is folded.
   */
  const projectActions = (key: string) => {
    const run = runs?.find((entry) => entry.key === key);
    if (!grouped || !run?.key || !run.path) return null;
    const ids = run.ids.filter((id) => tabs.some((tab) => tab.id === id));
    return {
      key: run.key,
      name: lookOf(run.path).name,
      ids,
      fallback: closeRunFallback(
        tabs.map((tab) => tab.id),
        ids,
        activeId,
      ),
      folded: collapsedGroups.has(run.key),
    };
  };
  type ProjectActions = NonNullable<ReturnType<typeof projectActions>>;

  const projectMenuItems = (project: ProjectActions): ExplorerMenuItem[] => [
    {
      kind: "item",
      id: "project-fold",
      label: project.folded
        ? `Expand ${project.name}`
        : `Collapse ${project.name}`,
    },
    {
      kind: "item",
      id: "project-close",
      label: `Close ${project.name} Tabs`,
      description:
        project.ids.length === 1 ? "1 tab" : `${project.ids.length} tabs`,
      disabled: project.ids.length === 0 || !project.fallback,
    },
  ];

  const pickProjectAction = (id: string, project: ProjectActions): boolean => {
    if (id === "project-fold") {
      toggleProjectTabGroup(project.key);
      return true;
    }
    if (id === "project-close") {
      if (project.fallback) onCloseMany(project.ids, project.fallback);
      return true;
    }
    return false;
  };

  const contextTab = tabMenu
    ? tabs.find((tab) => tab.id === tabMenu.tabId)
    : undefined;
  const contextCloseIds = contextTab
    ? {
        others: titleTabContextCloseIds(tabs, contextTab.id, "others"),
        right: titleTabContextCloseIds(tabs, contextTab.id, "right"),
        left: titleTabContextCloseIds(tabs, contextTab.id, "left"),
      }
    : null;
  const contextRunKey = contextTab
    ? runs?.find((run) => run.ids.includes(contextTab.id))?.key
    : undefined;
  const contextProject = contextRunKey ? projectActions(contextRunKey) : null;
  const contextMenuItems: ExplorerMenuItem[] = contextTab
    ? [
        {
          kind: "item",
          id: "close",
          label: "Close Tab",
          shortcut: `${MOD}W`,
          disabled: !titleTabClosable(contextTab, tabs.length),
        },
        { kind: "sep" },
        {
          kind: "item",
          id: "others",
          label: "Close Other Tabs",
          disabled: contextCloseIds?.others.length === 0,
        },
        {
          kind: "item",
          id: "right",
          label: "Close Tabs to the Right",
          disabled: contextCloseIds?.right.length === 0,
        },
        {
          kind: "item",
          id: "left",
          label: "Close Tabs to the Left",
          disabled: contextCloseIds?.left.length === 0,
        },
        ...(contextProject
          ? [{ kind: "sep" as const }, ...projectMenuItems(contextProject)]
          : []),
        ...(contextTab.sessionCount > 0 && (onArchiveTab || onDeleteTab)
          ? [
              { kind: "sep" as const },
              ...(onArchiveTab
                ? [
                    {
                      kind: "item" as const,
                      id: "archive",
                      label: "Archive",
                      description:
                        contextTab.sessionCount > 1
                          ? `All ${contextTab.sessionCount} conversations in this tab`
                          : undefined,
                    },
                  ]
                : []),
              ...(onDeleteTab
                ? [
                    {
                      kind: "item" as const,
                      id: "delete",
                      label: "Delete",
                      description:
                        contextTab.sessionCount > 1
                          ? `Permanently delete all ${contextTab.sessionCount} conversations in this tab`
                          : undefined,
                      danger: true,
                    },
                  ]
                : []),
            ]
          : []),
      ]
    : [];

  const onPickTabMenu = (id: string) => {
    if (!contextTab || !contextCloseIds) return;
    setTabMenu(null);
    if (contextProject && pickProjectAction(id, contextProject)) return;
    if (id === "close") {
      onClose(contextTab.id);
      return;
    }
    if (id === "archive") {
      onArchiveTab?.(contextTab.id);
      return;
    }
    if (id === "delete") {
      onDeleteTab?.(contextTab.id);
      return;
    }
    if (id === "others" || id === "right" || id === "left") {
      onCloseMany(contextCloseIds[id], contextTab.id);
    }
  };

  const stubProject = stubMenu ? projectActions(stubMenu.key) : null;
  const stubMenuItems: ExplorerMenuItem[] = stubProject
    ? projectMenuItems(stubProject)
    : [];

  const closeStubMenu = () => {
    const trigger = stubMenu?.trigger;
    setStubMenu(null);
    trigger?.focus();
  };

  const onPickStubMenu = (id: string) => {
    if (!stubProject) return;
    closeStubMenu();
    pickProjectAction(id, stubProject);
  };

  const railClosed = !projectRailOpen;
  const showCurrentProject = looksLikeProject(cwd);
  // Until a project is picked, the rail and the sidebar hide, so nothing
  // project-scoped is actionable and the window controls need room.
  const projectless = !showCurrentProject;
  // An open project is labeled in the sidebar, above Sessions / Explorer /
  // Changes. Without a project that sidebar is gone, so the picker stays here.
  const showProjectButton =
    railClosed && Boolean(onSelectProject) && !showCurrentProject;
  const showTrailingActions =
    !mono &&
    projectless &&
    railClosed &&
    Boolean(onOpenInbox || onOpenNotes || onOpenSettings);
  const trailingControls =
    showTrailingActions ||
    (mono && onShowMonoDetails) ||
    (!IS_MAC && !hideWindowControls) ? (
      <div className="flex h-full shrink-0 items-stretch">
        {mono && onShowMonoDetails ? (
          <div className="flex items-center px-3">
            <IconButton label="Show Mono details" onClick={onShowMonoDetails}>
              <PanelRightToggle className="size-3.5" strokeWidth={1.75} />
            </IconButton>
          </div>
        ) : null}
        {showTrailingActions ? (
          <div className="flex items-center gap-0.5 px-2">
            {projectless && railClosed && onOpenInbox ? (
              <IconButton label="Inbox" onClick={onOpenInbox}>
                <Inbox className="size-3.5" strokeWidth={1.75} />
              </IconButton>
            ) : null}
            {projectless && railClosed && onOpenNotes ? (
              <IconButton label="Notes" onClick={onOpenNotes}>
                <StickyNote className="size-3.5" strokeWidth={1.75} />
              </IconButton>
            ) : null}
            {!projectRailOpen && !showCurrentProject && onOpenSettings ? (
              <IconButton label={`Settings (${MOD},)`} onClick={onOpenSettings}>
                <Settings className="size-3.5" strokeWidth={1.75} />
              </IconButton>
            ) : null}
          </div>
        ) : null}
        {!IS_MAC && !hideWindowControls ? <WindowControls /> : null}
      </div>
    ) : null;

  // "deep" drags from anywhere in the subtree. The bare attribute only drags
  // on a direct hit, which left every label and spacer dead. Tauri still
  // exempts buttons, links and inputs on its own.
  return (
    <header
      className={`flex h-10 shrink-0 select-none items-stretch border-b border-stroke${
        compactRail && !mono ? " body-glass" : ""
      }`}
      data-tauri-drag-region="deep"
    >
      {compactRail ? (
        <div
          data-compact-title-nav
          // A full Mono's title bar starts beside the 48px compact rail.
          className={`flex shrink-0 items-center ${mono ? "pl-[22px]" : "pl-[70px]"}`}
        >
          <TabVisitNav
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            onGoBack={onGoBack}
            onGoForward={onGoForward}
          />
        </div>
      ) : null}
      {/* Both the rail and the sidebar step aside without a project, so the
          title bar takes over the traffic lights and the rail toggle. */}
      {projectless && railClosed && !compactRail ? (
        <>
          <div className="w-[78px] shrink-0" />
          <div className="flex shrink-0 items-center px-1.5">
            <IconButton
              label={`Toggle Sidebar (${MOD}B)`}
              onClick={onToggleSidebar}
            >
              <PanelLeft className="size-3.5" strokeWidth={1.75} />
            </IconButton>
          </div>
        </>
      ) : null}
      {!sessionSidebarOpen && !projectless && onToggleSessionSidebar ? (
        <div className="flex shrink-0 items-center px-1.5">
          {IS_MAC && railClosed && !compactRail ? (
            <div className="w-[70px] shrink-0" />
          ) : null}
          <IconButton
            label={`Toggle Session Sidebar (${MOD}${SHIFT}B)`}
            onClick={onToggleSessionSidebar}
          >
            <DashboardSquare className="size-3.5" strokeWidth={1.75} />
          </IconButton>
        </div>
      ) : null}
      {showProjectButton && onSelectProject ? (
        <CwdPicker
          cwd={cwd}
          recents={recents}
          placement="below"
          onCwdChange={onSelectProject}
          onNewTerminal={onNewTerminal}
          buttonClassName="flex h-full min-w-0 max-w-64 shrink items-center gap-2 px-6 text-left text-sm font-medium leading-tight"
        >
          <span className="min-w-0 truncate text-content/50">No project</span>
        </CwdPicker>
      ) : null}

      <div
        className={`flex min-w-0 flex-1 items-stretch${
          showProjectButton ? " border-l border-stroke" : ""
        }`}
      >
        {mono ? (
          <MonoTitle look={mono.look} state={mono.state} />
        ) : (
          <div
            className="relative h-full min-w-0 flex-1 overflow-hidden"
            onWheel={(event) => {
              const el = tabStripRef.current;
              if (!el || el.scrollWidth <= el.clientWidth) return;
              if (event.deltaX === 0 && event.deltaY !== 0) {
                el.scrollLeft += event.deltaY;
              }
            }}
          >
            {tabOverflow.left ? (
              <TabStripChevron side="left" onClick={() => scrollTabsBy(-1)} />
            ) : null}
            {tabOverflow.right ? (
              <TabStripChevron side="right" onClick={() => scrollTabsBy(1)} />
            ) : null}
            <div
              ref={setTabStripRef}
              data-title-tab-strip
              className="scrollbar-none flex h-full min-w-0 cursor-default items-center gap-0.5 overflow-x-auto overflow-y-hidden overscroll-none pl-1.5 pr-2.5"
            >
              {grouped && runs
                ? runs.map((run, index) => renderRun(run, index))
                : displayed.map((entry) => renderEntry(entry))}
            </div>
          </div>
        )}

        {mono ? null : <SessionPanelSlot />}

        {!IS_MAC && !IS_WIN ? (
          <div className="flex min-w-0 flex-1 items-center justify-center px-4">
            <span className="pointer-events-none truncate text-[11.5px] font-medium text-content/40 select-none">
              {systemTitle}
            </span>
          </div>
        ) : null}
        {trailingControls}
      </div>
      {tabMenu && contextTab ? (
        <ExplorerMenu
          x={tabMenu.x}
          y={tabMenu.y}
          width={244}
          items={contextMenuItems}
          ariaLabel={`Tab actions for ${tabCopy(contextTab).headline}`}
          onPick={onPickTabMenu}
          onClose={() => setTabMenu(null)}
        />
      ) : null}
      {stubMenu && stubProject ? (
        <ExplorerMenu
          x={stubMenu.x}
          y={stubMenu.y}
          width={220}
          items={stubMenuItems}
          ariaLabel={`Project actions for ${stubProject.name}`}
          onPick={onPickStubMenu}
          onClose={closeStubMenu}
        />
      ) : null}
    </header>
  );

  /**
   * One project's tabs, set off from the run before by a gap and folded to a
   * stub when collapsed; a projectless tab is its own run.
   */
  function renderRun(run: ProjectTabRun, index: number) {
    const key = run.key;
    const look = key && run.path ? lookOf(run.path) : null;
    const entries = displayed.slice(run.start, run.end);
    const live = entries.filter((entry) => !entry.closing);
    const collapsed = !!key && collapsedGroups.has(key);
    const fold = key ? () => toggleProjectTabGroup(key) : undefined;
    return (
      <Fragment key={key ?? run.ids[0]}>
        {index > 0 ? <ProjectTabGap /> : null}
        {look && key && collapsed ? (
          <ProjectTabStub
            look={look}
            count={live.length}
            harnesses={stubHarnesses(live.map((entry) => entry.item))}
            busy={live.some((entry) => entry.item.busyHarnesses.length > 0)}
            done={live.some(
              (entry) => (entry.item.doneHarnesses?.length ?? 0) > 0,
            )}
            onExpand={() => setProjectTabGroupCollapsed(key, false)}
            onOpenMenu={(x, y, trigger) => setStubMenu({ key, x, y, trigger })}
          />
        ) : null}
        {entries.map((entry) =>
          !entry.closing && hiddenIds.has(entry.item.id)
            ? null
            : renderEntry(entry, look?.color, fold),
        )}
      </Fragment>
    );
  }

  function renderEntry(
    entry: (typeof displayed)[number],
    tint?: string,
    onFoldProject?: () => void,
  ) {
    const tab = entry.item;
    const shell = (
      <div
        ref={(el) => {
          if (!entry.closing) setTabNode(tab.id, el);
        }}
        className={
          entry.closing || entry.opening
            ? "relative flex h-full w-full min-w-0 overflow-hidden items-center"
            : "relative flex h-full w-56 min-w-28 shrink cursor-default items-center"
        }
        data-title-tab-id={entry.closing ? undefined : tab.id}
        data-tab-slot-id={entry.closing ? undefined : tab.id}
        data-tauri-drag-region="false"
      >
        {!entry.closing && paneToTabDrop?.targetTabId === tab.id ? (
          <span
            data-pane-tab-drop-hint
            className={`pointer-events-none absolute inset-y-1 z-50 w-0.5 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)] ${
              paneToTabDrop.position === "before" ? "left-0" : "right-0"
            }`}
          />
        ) : null}
        <TitleTabItem
          tab={tab}
          active={!entry.closing && tab.id === activeId}
          closable={!entry.closing && titleTabClosable(tab, tabs.length)}
          canDrag={!entry.closing && canDrag}
          sortable={sortable}
          tint={tint}
          onSelect={onSelect}
          onClose={onClose}
          onPinFile={onPinFile}
          onFoldProject={entry.closing ? undefined : onFoldProject}
          onContextMenu={(tabId, event) =>
            setTabMenu({
              tabId,
              x: event.clientX,
              y: event.clientY,
            })
          }
          itemRef={
            !entry.closing && tab.id === activeId
              ? (el) => {
                  activeTabRef.current = el;
                }
              : undefined
          }
        />
      </div>
    );
    if (entry.closing || entry.opening) {
      return (
        <TabWidthMotion
          key={tab.id}
          phase={entry.closing ? "closing" : "opening"}
          width={entry.width}
          onFinish={() => finishMotion(tab.id)}
        >
          {shell}
        </TabWidthMotion>
      );
    }
    return (
      <div key={tab.id} className="contents">
        {shell}
      </div>
    );
  }
}

export const TitleBar = memo(TitleBarComponent);

/** In a Mono's view the title bar names it and shows its status. */
function MonoTitle({ look, state }: { look: MonoLook; state: MonoState }) {
  return (
    <div
      data-mono-title
      className="flex min-w-0 flex-1 items-center gap-2 px-4"
    >
      <PixelMascot
        name={look.mascot}
        color={look.color}
        status={state.status}
        still={state.status === "idle"}
        className="size-4 shrink-0"
      />
      <span className="min-w-0 truncate text-[13px] font-medium text-content">
        {look.name}
      </span>
      <span
        data-mono-status={state.status}
        className={`shrink-0 text-[12px] ${
          state.status === "needs-you" ? "text-accent" : "text-content/45"
        }`}
      >
        {MONO_STATUS_LABEL[state.status]}
      </span>
    </div>
  );
}
