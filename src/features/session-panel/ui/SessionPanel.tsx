import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { revealPath } from "../../../platform/tauri/fs";
import { ChevronRight, CornerDownRight } from "../../../shared/ui/icons";
import type { DocumentFile } from "../../file-cards/model/documentFiles";
import { sessionWorkCwd, type Session } from "../../sessions/model/session";
import { taskListProgressLabel } from "../../sessions/model/taskList";
import { sessionFacts } from "../model/sessionFacts";
import {
  loadSectionCollapsed,
  saveSectionCollapsed,
  SECTION_COLLAPSED_DEFAULT,
  SESSION_PANEL_WIDTH,
  subscribeSectionCollapsed,
} from "../model/sessionPanelState";
import { latestTaskListBlock } from "../model/sessionProgress";
import { sessionAttachments, sessionFolders } from "../model/sessionResources";
import { summarizeToolUse } from "../model/sessionToolUse";
import { usedRows, type UsedAction } from "../model/sessionUsedRows";
import { OutputsSection } from "./OutputsSection";
import { PanelSection } from "./PanelSection";
import { ProgressSection } from "./ProgressSection";
import { SessionPanelCloseButton } from "./SessionPanelToggle";
import { UsedSection } from "./UsedSection";
import type { SessionPanelControl } from "./useSessionPanel";

type PanelSession = Pick<
  Session,
  | "blocks"
  | "harness"
  | "model"
  | "runtimeMode"
  | "cwd"
  | "worktreeCwd"
  | "branch"
  | "context"
  | "extraDirs"
>;

type PanelActions = {
  /** Open a file the way the transcript's own file rows do. */
  onOpenFile: (path: string) => void;
  /** Scroll the transcript to a block, unfolding the work it sits in. */
  onShowInChat: (blockId: string) => void;
};

/**
 * The pane's session panel: nothing unless the viewer has it open. It is the
 * last column of the pane's row, so opening it pushes the transcript and the
 * composer aside. It never sits on top of either.
 */
export function SessionPanel({
  panel,
  session,
  visible = true,
  onOpenFile,
  onShowInChat,
}: PanelActions & {
  panel: SessionPanelControl;
  session: PanelSession;
  /** False while another tab is in front of the pane. */
  visible?: boolean;
}) {
  const close = useCallback(() => {
    panel.setOpen(false);
    panel.focusOpener();
  }, [panel.setOpen, panel.focusOpener]);
  if (!panel.available || !panel.open) return null;
  return (
    <SessionPanelView
      session={session}
      outputs={panel.outputs}
      visible={visible}
      takeFocus={panel.takeFocus}
      onClose={close}
      onOpenFile={onOpenFile}
      onShowInChat={onShowInChat}
    />
  );
}

/**
 * What a regular session is doing, at a glance, and a way into each part of
 * it: the agent's task list, the documents it has written, what it has drawn
 * on, and what it is running on. Everything is read from the session itself,
 * so the panel has nothing to load and nothing to save but its own layout.
 *
 * In a wide pane it is a card in a column of its own. In a narrow one the
 * same card floats over the top corner of the transcript.
 */
export function SessionPanelView({
  session,
  outputs,
  visible = true,
  takeFocus,
  onClose,
  onOpenFile,
  onShowInChat,
}: PanelActions & {
  session: PanelSession;
  outputs: readonly DocumentFile[];
  visible?: boolean;
  takeFocus?: () => boolean;
  onClose: () => void;
}) {
  const id = useId();
  const stepsId = useId();
  const progressFolded = useSyncExternalStore(
    subscribeSectionCollapsed,
    () => loadSectionCollapsed("progress"),
    () => SECTION_COLLAPSED_DEFAULT.progress,
  );
  const card = useRef<HTMLDivElement | null>(null);
  const workCwd = sessionWorkCwd(session);
  const tasks = useMemo(
    () => latestTaskListBlock(session.blocks),
    [session.blocks],
  );
  const taskList = tasks?.list ?? null;
  const toolUse = useMemo(
    () =>
      summarizeToolUse(session.blocks, {
        harness: session.harness,
        cwd: workCwd,
      }),
    [session.blocks, session.harness, workCwd],
  );
  const attachments = useMemo(
    () => sessionAttachments(session.blocks),
    [session.blocks],
  );
  const folders = useMemo(
    () => sessionFolders(session),
    [session.cwd, session.worktreeCwd, session.extraDirs],
  );
  const rows = useMemo(
    () => usedRows({ attachments, folders, use: toolUse }),
    [attachments, folders, toolUse],
  );
  const facts = useMemo(
    () => sessionFacts(session),
    [
      session.harness,
      session.model,
      session.runtimeMode,
      session.cwd,
      session.worktreeCwd,
      session.branch,
      session.context,
    ],
  );

  useEffect(() => {
    if (takeFocus?.()) card.current?.focus({ preventScroll: true });
    // Once, when the panel appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // A list open off a row takes Escape first and stops it from reaching here.
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  const act = useCallback(
    (action: UsedAction) => {
      if (action.kind === "open") onOpenFile(action.path);
      else if (action.kind === "chat") onShowInChat(action.blockId);
      else void revealPath(action.path).catch(() => undefined);
    },
    [onOpenFile, onShowInChat],
  );

  return (
    <aside
      id={id}
      aria-label="Session panel"
      data-session-panel
      style={{ width: SESSION_PANEL_WIDTH }}
      className="flex h-full min-h-0 shrink-0 flex-col py-2 pr-2 font-sans"
      onKeyDown={onKeyDown}
    >
      <div
        ref={card}
        tabIndex={-1}
        className="flex max-h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-content/10 bg-[color-mix(in_srgb,var(--color-content)_4%,var(--color-background-base))] shadow-sm outline-none"
      >
        <header className="flex h-11 shrink-0 items-center gap-2 pl-2 pr-2">
          <h3 className="min-w-0">
            <button
              type="button"
              aria-expanded={!progressFolded}
              aria-controls={stepsId}
              data-progress-fold
              className="group flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-content hover:bg-content/6 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              onClick={() => saveSectionCollapsed("progress", !progressFolded)}
            >
              <span className="truncate">Progress</span>
              <ChevronRight
                className={`size-3.5 shrink-0 text-content/40 transition-transform duration-150 group-hover:text-content/70 ${
                  progressFolded ? "" : "rotate-90"
                }`}
                strokeWidth={1.75}
              />
            </button>
          </h3>
          {taskList ? (
            <span
              data-progress-count
              className="shrink-0 rounded-full bg-content/7 px-2 py-0.5 font-mono text-[10px] text-content/50"
            >
              {taskListProgressLabel(taskList.items)}
            </span>
          ) : null}
          <span className="flex-1" />
          {tasks ? (
            <button
              type="button"
              title="Show the task list in chat"
              aria-label="Show the task list in chat"
              data-progress-show
              className="grid size-6.5 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              onClick={() => onShowInChat(tasks.blockId)}
            >
              <CornerDownRight className="size-3.5" strokeWidth={1.75} />
            </button>
          ) : null}
          <SessionPanelCloseButton controls={id} onClose={onClose} />
        </header>
        <div
          data-session-panel-body
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <div id={stepsId} hidden={progressFolded}>
            {progressFolded ? null : (
              <ProgressSection
                // A new list starts folded, whatever the last one was left as.
                key={taskList?.key ?? "tasks"}
                taskList={taskList}
              />
            )}
          </div>
          <OutputsSection files={outputs} onOpenFile={onOpenFile} />
          <UsedSection rows={rows} active={visible} onAction={act} />
          <PanelSection title="Session" fold="facts">
            <dl className="flex flex-col gap-0.5 px-2">
              {facts.map((fact) => (
                <div
                  key={fact.label}
                  className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start text-[12px]"
                >
                  <dt className="flex h-7 items-center text-content/45">
                    {fact.label}
                  </dt>
                  <dd
                    title={fact.title}
                    className="flex min-h-7 min-w-0 items-center text-content/85"
                  >
                    <span className="min-w-0 truncate">{fact.value}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </PanelSection>
        </div>
      </div>
    </aside>
  );
}
