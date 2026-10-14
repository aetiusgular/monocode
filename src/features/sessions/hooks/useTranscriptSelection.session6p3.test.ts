// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  paragraphRange,
  useTranscriptSelection,
} from "./useTranscriptSelection";
import {
  SELECTABLE_AGENT_RESPONSE_ATTR,
  TRANSCRIPT_SELECTION_MENU_ATTR,
  type TranscriptSelection,
} from "../model/transcriptSelection";
import { TranscriptSelectionMenu } from "../ui/TranscriptSelectionMenu";

// Mac 2.8 retest: a triple-click on a reply line saved
// `s7-a.txt in this folder with "a". The write to`, without "Created" and
// cut mid-sentence. The line had inline code spans at both cut points.

const LINE =
  'Created s7-a.txt in this folder with "a". The write to /Users/tonyg/Desktop/s7-b.txt was declined.';

let host: HTMLDivElement;
let reactRoot: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  reactRoot = createRoot(host);
});

afterEach(() => {
  act(() => reactRoot.unmount());
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function transcript() {
  const root = document.createElement("div");
  root.innerHTML = `
    <div ${SELECTABLE_AGENT_RESPONSE_ATTR}="r1">
      <p id="p0">Before.</p>
      <p id="p1">Created <code id="c1">s7-a.txt</code> in this folder with "a". The write to <code id="c2">/Users/tonyg/Desktop/s7-b.txt</code> was declined.</p>
      <ul><li id="li">Item with <code id="c3">code</code> inside.</li><li id="li2">Next item.</li></ul>
    </div>
    <div ${SELECTABLE_AGENT_RESPONSE_ATTR}="r2"><p id="p3">Second reply.</p></div>`;
  document.body.append(root);
  return root;
}

const byId = (id: string) => document.getElementById(id)!;

/** What WebKit selected on the Mac: the text between the two code spans. */
function webkitFragment(): Range {
  const range = document.createRange();
  range.setStart(byId("c1").nextSibling!, 0);
  range.setEnd(
    byId("c2").previousSibling!,
    ' in this folder with "a". The write to '.length,
  );
  return range;
}

describe("paragraphRange: a triple-click covers its whole block", () => {
  it("restores both ends cut at the inline code spans", () => {
    const root = transcript();
    const fragment = webkitFragment();
    expect(fragment.toString().trim()).toBe(
      'in this folder with "a". The write to',
    );
    const whole = paragraphRange(fragment, byId("c1").nextSibling, root)!;
    expect(whole.toString()).toBe(LINE);
  });

  it("takes the block from a click on a code span itself", () => {
    const root = transcript();
    const text = byId("c2").firstChild!;
    const range = document.createRange();
    range.selectNodeContents(text);
    expect(paragraphRange(range, text, root)!.toString()).toBe(LINE);
  });

  it("covers one list item, code included, and not the next", () => {
    const root = transcript();
    const text = byId("c3").firstChild!;
    const range = document.createRange();
    range.selectNodeContents(text);
    expect(paragraphRange(range, text, root)!.toString()).toBe(
      "Item with code inside.",
    );
  });

  it("keeps the extent of a triple-click drag across blocks", () => {
    const root = transcript();
    const range = document.createRange();
    range.setStart(byId("p0").firstChild!, 2);
    range.setEnd(byId("c1").nextSibling!, 3);
    const whole = paragraphRange(range, byId("p1").firstChild, root)!;
    expect(whole.toString().endsWith(LINE)).toBe(true);
    expect(whole.toString().startsWith("fore.")).toBe(true);
  });

  it("does nothing outside a reply", () => {
    const root = transcript();
    const outside = document.createElement("p");
    outside.textContent = "Composer text";
    document.body.append(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    expect(paragraphRange(range, outside.firstChild, root)).toBeNull();
  });
});

function Probe({
  root,
  onSelection,
}: {
  root: HTMLElement;
  onSelection: (selection: TranscriptSelection | null) => void;
}) {
  const { selection } = useTranscriptSelection(root, true);
  onSelection(selection);
  return null;
}

function mouse(target: Element, type: string, detail: number) {
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, detail, button: 0 }),
  );
}
function pointer(target: Element, type: string) {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0 }));
}

function rangeRects() {
  // happy-dom has no layout, so a range has no rects; give it one.
  const rect = new DOMRect(10, 10, 100, 16);
  vi.spyOn(Range.prototype, "getClientRects").mockReturnValue({
    length: 1,
    item: () => rect,
    [Symbol.iterator]: function* () {
      yield rect;
    },
  } as unknown as DOMRectList);
}

describe("the hook after a triple-click on the Mac line", () => {
  it("shows the menu with the whole line and selects it on the page", () => {
    rangeRects();
    const root = transcript();
    let seen: TranscriptSelection | null = null;
    act(() =>
      reactRoot.render(
        createElement(Probe, { root, onSelection: (s) => (seen = s) }),
      ),
    );
    const target = byId("p1");
    act(() => {
      mouse(target, "mousedown", 3);
      pointer(target, "pointerdown");
      const native = window.getSelection()!;
      native.removeAllRanges();
      native.addRange(webkitFragment());
      pointer(target, "pointerup");
      vi.runAllTimers();
    });
    expect(seen).not.toBeNull();
    expect(seen!.text).toBe(LINE);
    expect(window.getSelection()!.toString()).toBe(LINE);
  });

  it("leaves a single-click drag as the user made it", () => {
    rangeRects();
    const root = transcript();
    let seen: TranscriptSelection | null = null;
    act(() =>
      reactRoot.render(
        createElement(Probe, { root, onSelection: (s) => (seen = s) }),
      ),
    );
    const target = byId("p1");
    act(() => {
      mouse(target, "mousedown", 1);
      pointer(target, "pointerdown");
      const native = window.getSelection()!;
      native.removeAllRanges();
      native.addRange(webkitFragment());
      pointer(target, "pointerup");
      vi.runAllTimers();
    });
    expect(seen!.text).toBe('in this folder with "a". The write to');
  });

  it("keeps the menu's selection while the menu is pressed", () => {
    rangeRects();
    const root = transcript();
    let seen: TranscriptSelection | null = null;
    act(() =>
      reactRoot.render(
        createElement(Probe, { root, onSelection: (s) => (seen = s) }),
      ),
    );
    const target = byId("p1");
    act(() => {
      mouse(target, "mousedown", 3);
      pointer(target, "pointerdown");
      const native = window.getSelection()!;
      native.removeAllRanges();
      native.addRange(webkitFragment());
      pointer(target, "pointerup");
      vi.runAllTimers();
    });
    const menu = document.createElement("div");
    menu.setAttribute(TRANSCRIPT_SELECTION_MENU_ATTR, "");
    const button = document.createElement("button");
    menu.append(button);
    document.body.append(menu);
    act(() => {
      mouse(button, "mousedown", 1);
      pointer(button, "pointerdown");
      // WebKit moves the selection under the press.
      const native = window.getSelection()!;
      native.removeAllRanges();
      native.addRange(webkitFragment());
      document.dispatchEvent(new Event("selectionchange"));
      vi.runAllTimers();
    });
    expect(seen!.text).toBe(LINE);
  });
});

describe("the menu acts on the text it showed", () => {
  it("passes the text captured at the press, not a later selection", async () => {
    const onRemember = vi.fn();
    const rect = new DOMRect(10, 10, 100, 16);
    act(() =>
      reactRoot.render(
        createElement(TranscriptSelectionMenu, {
          selection: { text: LINE, rect },
          onRemember,
          onDismiss: () => undefined,
        }),
      ),
    );
    const menu = document.querySelector(`[${TRANSCRIPT_SELECTION_MENU_ATTR}]`);
    expect(menu).not.toBeNull();
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Remember this",
    )!;
    act(() => pointer(button, "pointerdown"));
    // The page's selection changes and the menu re-renders before the click.
    act(() =>
      reactRoot.render(
        createElement(TranscriptSelectionMenu, {
          selection: { text: "s7-a.txt in this folder", rect },
          onRemember,
          onDismiss: () => undefined,
        }),
      ),
    );
    await act(async () => {
      button.click();
    });
    expect(onRemember).toHaveBeenCalledWith(LINE);
  });

  it("names the failure as a memory failure", async () => {
    const rect = new DOMRect(10, 10, 100, 16);
    act(() =>
      reactRoot.render(
        createElement(TranscriptSelectionMenu, {
          selection: { text: LINE, rect },
          onRemember: () => {
            throw new Error("too long");
          },
          onDismiss: () => undefined,
        }),
      ),
    );
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Remember this",
    )!;
    await act(async () => {
      button.click();
    });
    expect(document.querySelector('[role="alert"]')!.textContent).toBe(
      "Could not remember this. too long",
    );
  });
});
