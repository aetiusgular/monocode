import { readFlag, writeFlag } from "../../settings/model/storageFlags";
import type { Session } from "../../sessions/model/session";

const SESSION_PANEL_OPEN_KEY = "monocode.sessionPanelOpen";

export const SESSION_PANEL_OPEN_DEFAULT = false;

/** Fired on `window` when the session panel is shown or hidden. */
export const SESSION_PANEL_OPEN_CHANGE_EVENT =
  "monocode:session-panel-open-change";

/** Width of the panel's column, card and gutter together, in px. */
export const SESSION_PANEL_WIDTH = 304;

/** Narrowest the transcript may be squeezed to make room for the panel, in px. */
export const SESSION_PANEL_MIN_TRANSCRIPT_WIDTH = 360;

/**
 * Narrowest pane that gets the panel, in px. The panel always takes a column
 * of its own and pushes the transcript aside; it never sits on top of it. A
 * pane too narrow to leave the transcript a readable column goes without.
 */
export const SESSION_PANEL_MIN_PANE_WIDTH =
  SESSION_PANEL_WIDTH + SESSION_PANEL_MIN_TRANSCRIPT_WIDTH;

/** Sections of the panel the viewer can fold away. */
export type SessionPanelSection = "progress" | "preview" | "used" | "facts";

const SECTION_COLLAPSED_KEY: Record<SessionPanelSection, string> = {
  progress: "monocode.sessionPanel.progressCollapsed",
  preview: "monocode.sessionPanel.previewCollapsed",
  used: "monocode.sessionPanel.usedCollapsed",
  facts: "monocode.sessionPanel.factsCollapsed",
};

/** What the session runs on rarely changes, so it starts folded. */
export const SECTION_COLLAPSED_DEFAULT: Record<SessionPanelSection, boolean> = {
  progress: false,
  preview: false,
  used: false,
  facts: true,
};

/** Fired on `window` when a section of the panel is folded or unfolded. */
export const SESSION_PANEL_SECTION_CHANGE_EVENT =
  "monocode:session-panel-section-change";

export function loadSectionCollapsed(section: SessionPanelSection): boolean {
  return (
    readFlag(SECTION_COLLAPSED_KEY[section]) ??
    SECTION_COLLAPSED_DEFAULT[section]
  );
}

export function saveSectionCollapsed(
  section: SessionPanelSection,
  value: boolean,
) {
  writeFlag(SECTION_COLLAPSED_KEY[section], value);
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SESSION_PANEL_SECTION_CHANGE_EVENT));
}

export function subscribeSectionCollapsed(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(SESSION_PANEL_SECTION_CHANGE_EVENT, onStoreChange);
  return () =>
    window.removeEventListener(
      SESSION_PANEL_SECTION_CHANGE_EVENT,
      onStoreChange,
    );
}

/** Whether the viewer keeps the session panel open, across every session. */
export function loadSessionPanelOpen(): boolean {
  return readFlag(SESSION_PANEL_OPEN_KEY) ?? SESSION_PANEL_OPEN_DEFAULT;
}

export function saveSessionPanelOpen(value: boolean) {
  writeFlag(SESSION_PANEL_OPEN_KEY, value);
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<boolean>(SESSION_PANEL_OPEN_CHANGE_EVENT, {
      detail: value,
    }),
  );
}

export function subscribeSessionPanelOpen(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(SESSION_PANEL_OPEN_CHANGE_EVENT, onStoreChange);
  return () =>
    window.removeEventListener(SESSION_PANEL_OPEN_CHANGE_EVENT, onStoreChange);
}

/**
 * Whether a session gets the panel at all. A Mono has its own Details panel,
 * an orchestration worker is shown inside its lead, and an Inbox conversation
 * is a temporary aside. A session with nothing in it yet has nothing to show.
 */
export function sessionHasPanel(
  session: Pick<Session, "blocks" | "inboxAsk" | "orchestrationLeadId">,
  isMono: boolean,
): boolean {
  return (
    !isMono &&
    !session.orchestrationLeadId &&
    !session.inboxAsk &&
    session.blocks.length > 0
  );
}

export function paneFitsSessionPanel(paneWidth: number): boolean {
  return paneWidth >= SESSION_PANEL_MIN_PANE_WIDTH;
}
