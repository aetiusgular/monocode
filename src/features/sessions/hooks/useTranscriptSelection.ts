import { useCallback, useEffect, useRef, useState } from "react";
import {
  SELECTABLE_AGENT_RESPONSE_ATTR,
  TRANSCRIPT_SELECTION_MENU_ATTR,
  validateTranscriptSelection,
  type TranscriptSelection,
} from "../model/transcriptSelection";

function responseIdForNode(
  node: Node | null,
  root: HTMLElement,
): string | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const response = element?.closest<HTMLElement>(
    `[${SELECTABLE_AGENT_RESPONSE_ATTR}]`,
  );
  if (!response || !root.contains(response)) return null;
  return response.getAttribute(SELECTABLE_AGENT_RESPONSE_ATTR);
}

function firstRangeRect(range: Range): DOMRect | null {
  const rects = range.getClientRects();
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects.item(index);
    if (rect && (rect.width > 0 || rect.height > 0)) return rect;
  }
  const rect = range.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 ? rect : null;
}

/**
 * The part of a selection that lies in one reply. A triple-click selects a
 * whole paragraph and WebKit ends that range at the start of whatever comes
 * after it, often outside the reply, so the two ends named different places
 * and no menu appeared (Mac 2.8). When everything past the reply holds no
 * text, the range is cut back to the reply's end.
 */
export function rangeWithinOneResponse(range: Range, root: HTMLElement): Range {
  const start = range.startContainer;
  const element = start instanceof Element ? start : start.parentElement;
  const response = element?.closest<HTMLElement>(
    `[${SELECTABLE_AGENT_RESPONSE_ATTR}]`,
  );
  if (!response || !root.contains(response)) return range;
  if (response.contains(range.endContainer)) return range;
  const doc = response.ownerDocument;
  const tail = doc.createRange();
  tail.setStart(response, response.childNodes.length);
  tail.setEnd(range.endContainer, range.endOffset);
  if (tail.toString().trim() !== "") return range;
  const inner = range.cloneRange();
  inner.setEnd(response, response.childNodes.length);
  return inner;
}

/** The blocks a triple-click selects whole: a paragraph, a list item, a heading, a cell. */
const TEXT_BLOCK_SELECTOR =
  "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, dt, dd, figcaption";

/**
 * A triple-click selection grown to cover the whole block it was made in,
 * inside one reply (Mac 2.8). Inline code renders as `inline-flex`, and
 * WebKit treats such a box as a paragraph edge, so a triple-click selected
 * only the text between two code spans and "Remember this" saved a fragment
 * cut at both ends. The block (paragraph, list item, heading, cell) is found
 * from the clicked node, or from the range start when the click is unknown.
 * The result spans both the block and the original range, so a triple-click
 * drag across blocks keeps its extent. Returns null when the click was not in
 * a reply.
 */
export function paragraphRange(
  range: Range,
  clicked: Node | null,
  root: HTMLElement,
): Range | null {
  const from = clicked ?? range.startContainer;
  const element = from instanceof Element ? from : from.parentElement;
  const response = element?.closest<HTMLElement>(
    `[${SELECTABLE_AGENT_RESPONSE_ATTR}]`,
  );
  if (!element || !response || !root.contains(response)) return null;
  const block = element.closest<HTMLElement>(TEXT_BLOCK_SELECTOR);
  const target = block && response.contains(block) ? block : response;
  const whole = response.ownerDocument.createRange();
  whole.selectNodeContents(target);
  if (whole.compareBoundaryPoints(Range.START_TO_START, range) > 0)
    whole.setStart(range.startContainer, range.startOffset);
  if (whole.compareBoundaryPoints(Range.END_TO_END, range) < 0)
    whole.setEnd(range.endContainer, range.endOffset);
  return whole;
}

export function useTranscriptSelection(
  root: HTMLElement | null,
  enabled: boolean,
): {
  selection: TranscriptSelection | null;
  dismissSelection: () => void;
} {
  const [selection, setSelection] = useState<TranscriptSelection | null>(null);
  const frame = useRef<number | null>(null);

  const dismissSelection = useCallback(() => setSelection(null), []);

  useEffect(() => {
    if (!enabled || !root) {
      dismissSelection();
      return;
    }

    let pointerSelecting = false;
    // The click count and node of the last press, from mousedown, since a
    // pointer event's detail does not count clicks.
    let clickCount = 0;
    let clickedNode: Node | null = null;
    let paragraphPending = false;
    // From a press on the menu until its release, the selection the menu
    // shows is the one it acts on; nothing re-reads it in between.
    let menuPressed = false;

    const cancelFrame = () => {
      if (frame.current == null) return;
      window.cancelAnimationFrame(frame.current);
      frame.current = null;
    };
    const reportSelection = () => {
      frame.current = null;
      const nativeSelection = window.getSelection();
      if (!nativeSelection || nativeSelection.rangeCount === 0) {
        setSelection(null);
        return;
      }
      let range = rangeWithinOneResponse(nativeSelection.getRangeAt(0), root);
      if (paragraphPending) {
        paragraphPending = false;
        const whole = paragraphRange(range, clickedNode, root);
        if (whole && whole.toString() !== range.toString()) {
          // Show the user the text the menu will act on.
          nativeSelection.removeAllRanges();
          nativeSelection.addRange(whole);
          range = whole;
        }
      }
      const text = validateTranscriptSelection({
        text: range.toString(),
        collapsed: range.collapsed,
        anchorResponseId: responseIdForNode(range.startContainer, root),
        focusResponseId: responseIdForNode(range.endContainer, root),
      });
      const rect = text ? firstRangeRect(range) : null;
      setSelection(text && rect ? { text, rect } : null);
    };
    const scheduleReport = () => {
      cancelFrame();
      frame.current = window.requestAnimationFrame(reportSelection);
    };
    const inMenu = (target: EventTarget | null) =>
      target instanceof Element &&
      target.closest(`[${TRANSCRIPT_SELECTION_MENU_ATTR}]`) != null;
    const onMouseDown = (event: MouseEvent) => {
      if (inMenu(event.target)) return;
      clickCount = event.detail;
      clickedNode = event.target as Node | null;
    };
    const onPointerDown = (event: PointerEvent) => {
      // A press on the menu keeps the selection it shows.
      if (inMenu(event.target)) {
        menuPressed = true;
        cancelFrame();
        return;
      }
      pointerSelecting = responseIdForNode(event.target as Node, root) != null;
      if (pointerSelecting) cancelFrame();
    };
    const onPointerUp = () => {
      if (menuPressed) {
        menuPressed = false;
        return;
      }
      if (!pointerSelecting) return;
      pointerSelecting = false;
      paragraphPending = clickCount >= 3;
      scheduleReport();
    };
    const onPointerCancel = () => {
      pointerSelecting = false;
      menuPressed = false;
    };
    const onSelectionChange = () => {
      if (!pointerSelecting && !menuPressed) scheduleReport();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (
        event.key === "Shift" ||
        (event.shiftKey && event.key.startsWith("Arrow"))
      ) {
        scheduleReport();
      }
    };

    document.addEventListener("mousedown", onMouseDown, { passive: true });
    document.addEventListener("pointerdown", onPointerDown, { passive: true });
    document.addEventListener("pointerup", onPointerUp, { passive: true });
    document.addEventListener("pointercancel", onPointerCancel, {
      passive: true,
    });
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      cancelFrame();
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerCancel);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [dismissSelection, enabled, root]);

  return { selection, dismissSelection };
}
