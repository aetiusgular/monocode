import {
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { DocumentFile } from "../../file-cards/model/documentFiles";
import { useFilesOnDisk } from "../../file-cards/ui/TurnFileCards";
import { sessionWorkCwd, type Session } from "../../sessions/model/session";
import {
  loadSessionPanelOpen,
  paneFitsSessionPanel,
  saveSessionPanelOpen,
  SESSION_PANEL_OPEN_DEFAULT,
  subscribeSessionPanelOpen,
} from "../model/sessionPanelState";
import { sessionOutputs } from "../model/sessionResources";

export type SessionPanelControl = {
  /** Goes on the element whose width the panel's column is carved out of. */
  paneRef: (element: HTMLElement | null) => void;
  /**
   * The session gets a panel and its pane has room to give it a column. The
   * panel never covers the transcript, so a pane without the room has none.
   */
  available: boolean;
  /** The viewer's choice, shared by every pane. */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Documents the agent has written in this session that are still on disk. */
  outputs: readonly DocumentFile[];
  /**
   * True once after the viewer opened the panel here, so it can take focus.
   * A panel that was simply left open does not pull focus from the composer.
   */
  takeFocus: () => boolean;
  /** Goes on the button that opens the panel, wherever the pane keeps it. */
  openerRef: RefObject<HTMLButtonElement | null>;
  /** Puts focus back on the button that opens the panel. */
  focusOpener: () => void;
};

type PanelSource = Pick<Session, "blocks" | "cwd" | "worktreeCwd" | "busy">;

const NO_OUTPUTS: readonly DocumentFile[] = [];

/**
 * Everything a pane needs to host the session panel: whether there is room
 * beside the transcript, whether the viewer wants it, and what the button
 * that opens it should count. `eligible` is the session's side of that (see
 * `sessionHasPanel`).
 */
export function useSessionPanel(
  eligible: boolean,
  session: PanelSource,
): SessionPanelControl {
  const wanted = useSyncExternalStore(
    subscribeSessionPanelOpen,
    loadSessionPanelOpen,
    () => SESSION_PANEL_OPEN_DEFAULT,
  );
  const [pane, setPane] = useState<HTMLElement | null>(null);
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    if (!pane || !eligible) return;
    const measure = () => {
      const width = pane.getBoundingClientRect().width;
      // A hidden tab has zero-size boxes. Keep what it measured while shown,
      // so coming back to it does not lay the transcript out twice.
      if (width > 0) setFits(paneFitsSessionPanel(width));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [pane, eligible]);
  const paneRef = useCallback(
    (element: HTMLElement | null) => setPane(element),
    [],
  );

  const focusNext = useRef(false);
  const setOpen = useCallback((open: boolean) => {
    focusNext.current = open;
    saveSessionPanelOpen(open);
  }, []);
  const takeFocus = useCallback(() => {
    const wanted = focusNext.current;
    focusNext.current = false;
    return wanted;
  }, []);
  // The button is not in the pane: it sits in the title bar or a pane header.
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const focusOpener = useCallback(() => {
    requestAnimationFrame(() =>
      openerRef.current?.focus({ preventScroll: true }),
    );
  }, []);

  const workCwd = sessionWorkCwd(session);
  const live = !!session.busy;
  const written = useMemo(
    () =>
      eligible
        ? sessionOutputs(session.blocks, { cwd: workCwd, live })
        : NO_OUTPUTS,
    [eligible, session.blocks, workCwd, live],
  );
  const outputs = useFilesOnDisk(written, live);

  return {
    paneRef,
    available: eligible && fits,
    open: eligible && fits && wanted,
    setOpen,
    outputs,
    takeFocus,
    openerRef,
    focusOpener,
  };
}
