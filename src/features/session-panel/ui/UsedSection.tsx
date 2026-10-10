import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Bot,
  CornerDownRight,
  File,
  Folder,
  FolderOpen,
  Globe,
  ImagePlus,
  Search,
  Share,
  Terminal,
  Wrench,
} from "../../../shared/ui/icons";
import { Popover } from "../../../shared/ui/Popover";
import { REVEAL_LABEL } from "../../file-cards/ui/FileCard";
import {
  usedActionLabel,
  type UsedAction,
  type UsedEntry,
  type UsedRow,
  type UsedRowId,
} from "../model/sessionUsedRows";
import { EmptyNote, PanelSection } from "./PanelSection";

/** How long the pointer rests on a row before its list opens, in ms. */
const HOVER_OPEN_MS = 140;
/** How long the list waits for the pointer to cross over to it, in ms. */
const HOVER_CLOSE_MS = 200;
/** Entries one list renders before it says how many it left out. */
export const MAX_LIST_ENTRIES = 150;

const ICON = {
  className: "size-3.5 shrink-0 text-content/50",
  strokeWidth: 1.75,
} as const;

const ROW_ICON: Record<UsedRowId, ReactNode> = {
  attachments: <ImagePlus {...ICON} />,
  folders: <Folder {...ICON} />,
  connectors: <Share {...ICON} />,
  files: <File {...ICON} />,
  commands: <Terminal {...ICON} />,
  web: <Globe {...ICON} />,
  searches: <Search {...ICON} />,
  subagents: <Bot {...ICON} />,
  other: <Wrench {...ICON} />,
};

type OpenList = {
  id: UsedRowId;
  /** Opened by a click or the keyboard: it stays until dismissed. */
  pinned: boolean;
};

/**
 * What the session has drawn on: the user's attachments, its folders, the
 * connectors it called, and the files, commands and searches behind its work.
 * Each row names the first of its kind and opens the full list beside the
 * panel, on hover for a look and on click to keep it there.
 */
export function UsedSection({
  rows,
  active = true,
  onAction,
}: {
  rows: readonly UsedRow[];
  /** False while the pane is behind another tab: no list may stay up. */
  active?: boolean;
  onAction: (action: UsedAction) => void;
}) {
  return (
    <PanelSection title="Used in this session" fold="used">
      {rows.length === 0 ? (
        <EmptyNote>
          Nothing yet. Attachments, folders, connectors, files and commands the
          session uses are listed here.
        </EmptyNote>
      ) : (
        // Its own component, so folding the section drops any open list.
        <UsedRows rows={rows} active={active} onAction={onAction} />
      )}
    </PanelSection>
  );
}

function UsedRows({
  rows,
  active,
  onAction,
}: {
  rows: readonly UsedRow[];
  active: boolean;
  onAction: (action: UsedAction) => void;
}) {
  const [open, setOpen] = useState<OpenList | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const anchors = useRef(new Map<UsedRowId, HTMLButtonElement>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  // The list is portalled out of the pane, so hiding the pane does not hide it.
  useEffect(() => {
    if (active) return;
    cancel();
    setOpen(null);
  }, [active, cancel]);

  const hoverOpen = (id: UsedRowId) => {
    cancel();
    timer.current = setTimeout(
      () =>
        setOpen((current) =>
          current?.pinned ? current : { id, pinned: false },
        ),
      HOVER_OPEN_MS,
    );
  };
  const hoverClose = useCallback(() => {
    cancel();
    timer.current = setTimeout(
      () => setOpen((current) => (current?.pinned ? current : null)),
      HOVER_CLOSE_MS,
    );
  }, [cancel]);
  const toggle = (id: UsedRowId) => {
    cancel();
    setOpen((current) =>
      current?.id === id && current.pinned ? null : { id, pinned: true },
    );
  };
  /** Shuts the list and, when asked, hands focus back to its row. */
  const close = useCallback(
    (refocus: boolean) => {
      cancel();
      const id = openRef.current?.id;
      setOpen(null);
      if (refocus && id) {
        anchors.current.get(id)?.focus({ preventScroll: true });
      }
    },
    [cancel],
  );
  // Stable, so the list does not re-register its listeners on every token.
  const dismiss = useCallback(
    (reason: "outside" | "escape") => close(reason === "escape"),
    [close],
  );
  const pick = useCallback(
    (action: UsedAction) => {
      onAction(action);
      // Opening a file or a folder takes the viewer somewhere else; a jump
      // within the chat leaves the list up for the next one.
      if (action.kind !== "chat") close(false);
    },
    [onAction, close],
  );
  /** Tab past either end of the list leaves it, back to its row. */
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const stops = [
      ...event.currentTarget.querySelectorAll<HTMLElement>("button"),
    ];
    const at = document.activeElement;
    const leaving = event.shiftKey
      ? at === event.currentTarget || at === stops[0]
      : at === stops[stops.length - 1] || stops.length === 0;
    if (!leaving) return;
    event.preventDefault();
    close(true);
  };

  const shown = open ? rows.find((row) => row.id === open.id) : undefined;
  const anchor = shown ? anchors.current.get(shown.id) : undefined;
  return (
    <>
      <ul>
        {rows.map((row) => {
          const expanded = open?.id === row.id;
          return (
            <li key={row.id}>
              <button
                type="button"
                ref={(element) => {
                  if (element) anchors.current.set(row.id, element);
                  else anchors.current.delete(row.id);
                }}
                data-used-row={row.id}
                aria-haspopup="dialog"
                aria-expanded={expanded}
                className={`flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                  expanded ? "bg-content/8" : "hover:bg-content/6"
                }`}
                onMouseEnter={() => hoverOpen(row.id)}
                onMouseLeave={hoverClose}
                onClick={() => toggle(row.id)}
              >
                {ROW_ICON[row.id]}
                <span className="shrink-0 text-[12.5px] text-content/90">
                  {row.label}
                </span>
                <span
                  data-used-preview
                  className="min-w-0 flex-1 truncate text-right text-[11.5px] text-content/40"
                >
                  {row.preview}
                </span>
                {row.more > 0 ? (
                  <span
                    data-used-more
                    className="shrink-0 text-[11.5px] tabular-nums text-content/50"
                  >
                    +{row.more}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {open && shown && anchor ? (
        <Popover
          // A fresh list for each row, so it grows from the row it belongs to.
          key={shown.id}
          anchor={anchor}
          side="left"
          align="start"
          gap={10}
          width={300}
          maxHeight={360}
          onDismiss={dismiss}
          // A list that is only being looked at must not take Escape from
          // whatever the viewer is typing into.
          dismissOnEscape={open.pinned}
          autoFocus={open.pinned}
          tabIndex={-1}
          role="dialog"
          aria-label={shown.label}
          data-used-list={shown.id}
          data-used-pinned={open.pinned || undefined}
          className="flex flex-col p-1.5"
          onMouseEnter={cancel}
          onMouseLeave={hoverClose}
          onKeyDown={onListKeyDown}
        >
          <UsedList row={shown} onAction={pick} />
        </Popover>
      ) : null}
    </>
  );
}

function UsedList({
  row,
  onAction,
}: {
  row: UsedRow;
  onAction: (action: UsedAction) => void;
}) {
  let budget = MAX_LIST_ENTRIES;
  const groups = row.groups.map((group) => {
    const entries = group.entries.slice(0, budget);
    budget -= entries.length;
    return { ...group, entries };
  });
  const left = row.total - (MAX_LIST_ENTRIES - budget);
  return (
    <>
      <div className="flex shrink-0 items-baseline justify-between gap-3 px-2 pb-1 pt-0.5">
        <p className="text-[12px] font-medium text-content/85">{row.label}</p>
        <p className="text-[11px] tabular-nums text-content/40">{row.total}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {groups.map((group, index) =>
          group.entries.length === 0 ? null : (
            <div
              key={group.title ?? index}
              role="group"
              aria-label={group.title}
            >
              {group.title ? (
                <p className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-content/40">
                  {group.title}
                </p>
              ) : null}
              <ul>
                {group.entries.map((entry) => (
                  <li key={entry.key}>
                    <UsedEntryButton entry={entry} onAction={onAction} />
                  </li>
                ))}
              </ul>
            </div>
          ),
        )}
        {left > 0 ? (
          <p className="px-2 py-1.5 text-[11px] text-content/40">
            and {left} more
          </p>
        ) : null}
      </div>
    </>
  );
}

function UsedEntryButton({
  entry,
  onAction,
}: {
  entry: UsedEntry;
  onAction: (action: UsedAction) => void;
}) {
  const hint = usedActionLabel(entry.action, REVEAL_LABEL);
  return (
    <button
      type="button"
      data-used-entry={entry.action.kind}
      title={`${hint}: ${entry.full ?? entry.label}`}
      className="group flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-content/8 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      onClick={() => onAction(entry.action)}
    >
      {entry.thumb ? (
        <img
          src={entry.thumb}
          alt=""
          className="mt-px size-5 shrink-0 rounded object-cover"
        />
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            className={`truncate text-content/90 ${
              entry.detailShrinks ? "max-w-[75%] shrink-0" : "min-w-0"
            } ${entry.mono ? "font-mono text-[11.5px]" : "text-[12.5px]"}`}
          >
            {entry.label}
          </span>
          {entry.detail ? (
            <span
              className={`text-[11px] tabular-nums text-content/40 ${
                entry.detailShrinks ? "min-w-0 truncate" : "shrink-0"
              }`}
            >
              {entry.detail}
            </span>
          ) : null}
        </span>
        {entry.sub?.map((line) => (
          <span
            key={line}
            className="block truncate font-mono text-[11px] leading-4 text-content/45"
          >
            {line}
          </span>
        ))}
      </span>
      <span
        aria-hidden
        className="mt-0.5 shrink-0 text-content/0 group-hover:text-content/50 group-focus-visible:text-content/50"
      >
        {entry.action.kind === "chat" ? (
          <CornerDownRight className="size-3.5" strokeWidth={1.75} />
        ) : entry.action.kind === "reveal" ? (
          <FolderOpen className="size-3.5" strokeWidth={1.75} />
        ) : (
          <File className="size-3.5" strokeWidth={1.75} />
        )}
      </span>
    </button>
  );
}
