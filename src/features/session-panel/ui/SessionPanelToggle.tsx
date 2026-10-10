import { createPortal } from "react-dom";
import { File, PanelRight, X } from "../../../shared/ui/icons";
import { useSessionPanelSlot } from "./SessionPanelSlot";
import type { SessionPanelControl } from "./useSessionPanel";

/**
 * Opens and closes the session panel. The button never sits on the chat: a
 * pane that fills the window puts it in the window's title bar, beside the
 * tabs, and a pane in a split puts it in the pane's own header. Once the
 * agent has written documents, the button counts them, so there is a reason
 * to open it. It stays put while the panel is open, as a second way to close
 * it.
 */
export function SessionPanelToggle({
  panel,
  place,
  shown = true,
}: {
  panel: SessionPanelControl;
  /** Where the pane keeps the button. See above. */
  place: "title-bar" | "pane-header";
  /** False for a pane that is mounted and not on show, such as a parked tab. */
  shown?: boolean;
}) {
  const slot = useSessionPanelSlot();
  if (!panel.available || !shown) return null;
  const count = panel.outputs.length;
  const label = panel.open ? "Hide session panel" : "Show session panel";
  const outputs =
    count === 0 ? "" : count === 1 ? " · 1 output" : ` · ${count} outputs`;
  const inHeader = place === "pane-header";
  const button = (
    <button
      ref={panel.openerRef}
      type="button"
      title={`${label}${outputs}`}
      aria-label={label}
      aria-expanded={panel.open}
      data-session-panel-toggle={place}
      data-output-count={count}
      data-tauri-drag-region="false"
      data-no-drag
      className={`flex shrink-0 items-center justify-center gap-1 rounded-md font-sans text-[11.5px] font-medium tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        inHeader ? "h-5 min-w-5 px-1" : "h-6.5 min-w-6.5 px-1.5"
      } ${
        panel.open
          ? "bg-content/10 text-content"
          : "text-content/50 hover:bg-content/10 hover:text-content"
      }`}
      // A split pane's header is a drag handle; the button is not.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => panel.setOpen(!panel.open)}
    >
      {count > 0 ? (
        <>
          <File className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span>{count}</span>
        </>
      ) : (
        <PanelRight className="size-3.5 shrink-0" strokeWidth={1.75} />
      )}
    </button>
  );
  if (inHeader) return button;
  return slot ? createPortal(button, slot) : null;
}

/** The matching button in the open panel's header. */
export function SessionPanelCloseButton({
  controls,
  onClose,
}: {
  /** Id of the panel this button closes. */
  controls: string;
  onClose: () => void;
}) {
  return (
    <button
      type="button"
      title="Close"
      aria-label="Close session panel"
      aria-controls={controls}
      data-session-panel-close
      className="grid size-6.5 shrink-0 place-items-center rounded-md text-content/60 hover:bg-content/10 hover:text-content focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      onClick={onClose}
    >
      <X className="size-4" strokeWidth={1.75} />
    </button>
  );
}
