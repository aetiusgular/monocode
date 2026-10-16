import {
  FilePlusCorner,
  MessageSquarePlus,
  StickyNote,
} from "../../../shared/ui/icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Popover } from "../../../shared/ui/Popover";
import {
  TRANSCRIPT_SELECTION_MENU_ATTR,
  type TranscriptSelection,
} from "../model/transcriptSelection";

type Props = {
  selection: TranscriptSelection | null;
  onAddToChat?: (text: string) => void;
  onAddToNotes?: (text: string) => void | Promise<void>;
  /** #36: save the selection to the project's memory. */
  onRemember?: (text: string) => void | Promise<void>;
  onDismiss: () => void;
};

export function TranscriptSelectionMenu({
  selection,
  onAddToChat,
  onAddToNotes,
  onRemember,
  onDismiss,
}: Props) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // Scrolling or resizing moves the text out from under the menu, so the
  // selection it acts on is gone; drop it rather than chase the range.
  useEffect(() => {
    if (!selection) return;
    const dismiss = () => onDismissRef.current();
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [selection]);

  if (!selection) return null;

  return (
    <SelectionMenuSurface
      selection={selection}
      onAddToChat={onAddToChat}
      onAddToNotes={onAddToNotes}
      onRemember={onRemember}
      onDismiss={onDismiss}
    />
  );
}

/** How wide the menu grows while it shows why an action failed (Mac 2.8). */
export const SELECTION_MENU_FAILURE_WIDTH = 256;

/**
 * The open menu. It unmounts when the selection is dropped, which clears a
 * failure it showed.
 */
function SelectionMenuSurface({
  selection,
  onAddToChat,
  onAddToNotes,
  onRemember,
  onDismiss,
}: Omit<Props, "selection"> & { selection: TranscriptSelection }) {
  // Mac 2.8: a failure reason is wrapped at a readable width, and the menu
  // is measured at its full height, so it moves below the selection rather
  // than cut the reason off when there is no room above.
  const [failed, setFailed] = useState(false);
  return (
    <Popover
      anchor={selection.rect}
      side="top"
      align="center"
      width={failed ? SELECTION_MENU_FAILURE_WIDTH : undefined}
      constrainHeight={false}
      onDismiss={(reason) => {
        if (reason === "escape") window.getSelection()?.removeAllRanges();
        onDismiss();
      }}
      role="toolbar"
      aria-label="Selected text actions"
      {...{ [TRANSCRIPT_SELECTION_MENU_ATTR]: "" }}
      className="p-1"
    >
      <div className="flex min-w-36 flex-col items-stretch gap-0.5">
        {onAddToChat ? (
          <SelectionAction
            label="Add to chat"
            text={selection.text}
            onSelect={onAddToChat}
            onDismiss={onDismiss}
            onFailed={() => setFailed(true)}
          >
            <MessageSquarePlus
              aria-hidden="true"
              className="size-3.5"
              strokeWidth={1.75}
            />
          </SelectionAction>
        ) : null}
        {onAddToNotes ? (
          <SelectionAction
            label="Add to notes"
            text={selection.text}
            onSelect={onAddToNotes}
            onDismiss={onDismiss}
            onFailed={() => setFailed(true)}
          >
            <FilePlusCorner
              aria-hidden="true"
              className="size-3.5"
              strokeWidth={1.75}
            />
          </SelectionAction>
        ) : null}
        {onRemember ? (
          <SelectionAction
            label="Remember this"
            failure="Could not remember this."
            text={selection.text}
            onSelect={onRemember}
            onDismiss={onDismiss}
            onFailed={() => setFailed(true)}
          >
            <StickyNote
              aria-hidden="true"
              className="size-3.5"
              strokeWidth={1.75}
            />
          </SelectionAction>
        ) : null}
      </div>
    </Popover>
  );
}

/**
 * One menu action. It acts on the text the menu showed when it was pressed,
 * never on a fresh read of the page's selection (Mac 2.8).
 */
function SelectionAction({
  label,
  failure = "Could not save note.",
  text,
  children,
  onSelect,
  onDismiss,
  onFailed,
}: {
  label: string;
  failure?: string;
  text: string;
  children: ReactNode;
  onSelect: (text: string) => void | Promise<void>;
  onDismiss: () => void;
  onFailed?: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pressed = useRef<string | null>(null);
  return (
    <>
      <button
        type="button"
        disabled={pending}
        onPointerDown={() => {
          pressed.current = text;
        }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={async () => {
          const acted = pressed.current ?? text;
          pressed.current = null;
          setPending(true);
          setError(null);
          try {
            const result = onSelect(acted);
            if (result) await result;
            window.getSelection()?.removeAllRanges();
            onDismiss();
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
            onFailed?.();
          } finally {
            setPending(false);
          }
        }}
        className="flex h-8 w-full items-center gap-2 whitespace-nowrap rounded-lg px-2.5 font-sans text-[13px] leading-none text-content outline-none ring-accent/40 hover:bg-content/5 focus-visible:ring-2"
      >
        {children}
        {label}
      </button>
      {error && (
        <span
          role="alert"
          className="whitespace-normal break-words px-2.5 py-1 text-xs leading-4 text-content/70"
        >
          {failure} {error}
        </span>
      )}
    </>
  );
}
