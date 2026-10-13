import { useCallback, useEffect, useRef, useState } from "react";
import {
  SELECTABLE_AGENT_RESPONSE_ATTR,
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
      const range = rangeWithinOneResponse(nativeSelection.getRangeAt(0), root);
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
    const onPointerDown = (event: PointerEvent) => {
      pointerSelecting = responseIdForNode(event.target as Node, root) != null;
      if (pointerSelecting) cancelFrame();
    };
    const onPointerUp = () => {
      if (!pointerSelecting) return;
      pointerSelecting = false;
      scheduleReport();
    };
    const onPointerCancel = () => {
      pointerSelecting = false;
    };
    const onSelectionChange = () => {
      if (!pointerSelecting) scheduleReport();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (
        event.key === "Shift" ||
        (event.shiftKey && event.key.startsWith("Arrow"))
      ) {
        scheduleReport();
      }
    };

    document.addEventListener("pointerdown", onPointerDown, { passive: true });
    document.addEventListener("pointerup", onPointerUp, { passive: true });
    document.addEventListener("pointercancel", onPointerCancel, {
      passive: true,
    });
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      cancelFrame();
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerCancel);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [dismissSelection, enabled, root]);

  return { selection, dismissSelection };
}
