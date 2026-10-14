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
 * KaTeX draws visible math as `.katex-html` marked aria-hidden, and keeps a
 * MathML copy for screen readers clipped out of sight. Inside a `.katex`
 * element the drawn copy counts as shown and the MathML copy as hidden, so
 * selected math is kept once (security fix X3).
 */
function katexPart(element: Element): "html" | "mathml" | null {
  const inKatex = element.parentElement?.closest(".katex");
  if (!inKatex) return null;
  if (element.classList.contains("katex-html")) return "html";
  if (element.classList.contains("katex-mathml")) return "mathml";
  return null;
}

/** An element whose text the user cannot see, cached per element. */
function hiddenElement(
  element: Element,
  cache: Map<Element, boolean>,
): boolean {
  const known = cache.get(element);
  if (known !== undefined) return known;
  let hidden = false;
  const katex = katexPart(element);
  if (element instanceof HTMLElement && element.hidden) hidden = true;
  else if (katex === "mathml") hidden = true;
  else if (katex !== "html" && element.getAttribute("aria-hidden") === "true")
    hidden = true;
  else if (element.classList.contains("sr-only")) hidden = true;
  else {
    const view = element.ownerDocument.defaultView;
    const style = view?.getComputedStyle(element);
    if (style) {
      if (style.display === "none") hidden = true;
      else if (style.visibility === "hidden" || style.visibility === "collapse")
        hidden = true;
      else if (/^rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)$/.test(style.clip))
        hidden = true;
      else if (/^inset\(50%\)$/.test(style.clipPath ?? "")) hidden = true;
    }
  }
  cache.set(element, hidden);
  return hidden;
}

/** True when a node sits in a closed `<details>` outside its summary. */
function inClosedDetails(node: Node, stop: Node): boolean {
  let child: Node = node;
  let parent = node.parentNode;
  while (parent && child !== stop) {
    if (parent instanceof HTMLDetailsElement && !parent.open) {
      const summary = parent.querySelector(":scope > summary");
      if (!summary || child !== summary) return true;
    }
    child = parent;
    parent = parent.parentNode;
  }
  return false;
}

/**
 * The text of a range as the user sees it. `Range.toString()` also returns
 * the body of a collapsed `<details>` and text hidden by CSS, which the user
 * never saw selected, and that text must never be saved or sent. Text nodes
 * under a hidden element or a closed `<details>` (its summary aside) are
 * left out.
 */
export function renderedRangeText(range: Range): string {
  const rootNode = range.commonAncestorContainer;
  const doc = rootNode.ownerDocument ?? (rootNode as Document);
  const cache = new Map<Element, boolean>();
  const visible = (node: Node) => {
    if (inClosedDetails(node, doc)) return false;
    for (
      let element = node.parentElement;
      element;
      element = element.parentElement
    ) {
      if (hiddenElement(element, cache)) return false;
    }
    return true;
  };
  const piece = (node: Text) => {
    const data = node.data;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : data.length;
    return data.slice(start, end);
  };
  if (rootNode.nodeType === Node.TEXT_NODE) {
    return visible(rootNode) ? piece(rootNode as Text) : "";
  }
  const walker = doc.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    if (visible(node)) text += piece(node as Text);
  }
  return text;
}

/**
 * True when an element, or an ancestor inside the reply, clips its lines
 * (`line-clamp`). A collapsed user message shows four lines; growing a
 * selection there would take lines the user cannot see.
 */
function clampedWithin(element: Element, response: Element): boolean {
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  ) {
    if ([...current.classList].some((name) => name.startsWith("line-clamp-")))
      return true;
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    const clamp = style?.getPropertyValue("-webkit-line-clamp");
    if (clamp && clamp !== "none") return true;
    if (current === response) break;
  }
  return false;
}

/**
 * A triple-click selection grown to cover the whole block it was made in,
 * inside one reply (Mac 2.8). Inline code renders as `inline-flex`, and
 * WebKit treats such a box as a paragraph edge, so a triple-click selected
 * only the text between two code spans and "Remember this" saved a fragment
 * cut at both ends. The block (paragraph, list item, heading, cell) is found
 * from the clicked node, or from the range start when the click is unknown.
 * The result spans both the block and the original range, so a triple-click
 * drag across blocks keeps its extent. Returns null, and the user's own
 * selection stands, when the click was not in a reply, when no such block
 * holds it (a code block header, a summary, a bare div), or when the block
 * is clamped to fewer lines than it holds.
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
  if (!block || !response.contains(block)) return null;
  if (clampedWithin(block, response)) return null;
  const whole = response.ownerDocument.createRange();
  whole.selectNodeContents(block);
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
        if (whole && renderedRangeText(whole) !== renderedRangeText(range)) {
          // Show the user the text the menu will act on.
          nativeSelection.removeAllRanges();
          nativeSelection.addRange(whole);
          range = whole;
        }
      }
      const text = validateTranscriptSelection({
        text: renderedRangeText(range),
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
