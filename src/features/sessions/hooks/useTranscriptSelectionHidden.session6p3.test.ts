// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  paragraphRange,
  renderedRangeText,
  useTranscriptSelection,
} from "./useTranscriptSelection";
import {
  SELECTABLE_AGENT_RESPONSE_ATTR,
  type TranscriptSelection,
} from "../model/transcriptSelection";

// Security review W1: a triple-click with no paragraph, item or cell around
// it grew to the whole reply, and Range.toString() then carried the body of
// a collapsed <details> and CSS-hidden labels into "Remember this" and
// "Add to chat". Text the user did not see selected is never saved or sent.

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
  vi.restoreAllMocks();
});

const SECRET = "SECRET-HIDDEN-TEXT";

function transcript() {
  const root = document.createElement("div");
  root.innerHTML = `
    <div ${SELECTABLE_AGENT_RESPONSE_ATTR}="r1">
      <p id="p0">Visible paragraph.</p>
      <div id="codehead"><span id="lang">bash</span><span class="sr-only" id="srlabel">${SECRET} label</span></div>
      <pre id="code">echo hi</pre>
      <details id="det"><summary id="sum">CI context</summary><p id="detbody">${SECRET} body</p></details>
      <div id="bare">Bare div text.</div>
      <span style="display:none" id="none">${SECRET} display</span>
      <span style="visibility:hidden" id="vis">${SECRET} visibility</span>
      <span hidden id="attr">${SECRET} attribute</span>
    </div>
    <pre ${SELECTABLE_AGENT_RESPONSE_ATTR}="u1" id="user" class="user-message-text line-clamp-4">line one
line two
line three
line four
${SECRET} line five</pre>`;
  document.body.append(root);
  return root;
}

const byId = (id: string) => document.getElementById(id)!;

function wordRange(id: string): Range {
  const range = document.createRange();
  range.selectNodeContents(byId(id).firstChild!);
  return range;
}

describe("paragraphRange: no block means no growing", () => {
  it("does not grow from a code block header span", () => {
    const root = transcript();
    expect(
      paragraphRange(wordRange("lang"), byId("lang").firstChild, root),
    ).toBeNull();
  });

  it("does not grow from a summary", () => {
    const root = transcript();
    expect(
      paragraphRange(wordRange("sum"), byId("sum").firstChild, root),
    ).toBeNull();
  });

  it("does not grow from a bare div", () => {
    const root = transcript();
    expect(
      paragraphRange(wordRange("bare"), byId("bare").firstChild, root),
    ).toBeNull();
  });

  it("does not grow past the shown lines of a clamped user message", () => {
    const root = transcript();
    const text = byId("user").firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, "line one".length);
    expect(paragraphRange(range, text, root)).toBeNull();
  });

  it("still grows inside a paragraph", () => {
    const root = transcript();
    const text = byId("p0").firstChild!;
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 5);
    expect(paragraphRange(range, text, root)!.toString()).toBe(
      "Visible paragraph.",
    );
  });
});

describe("renderedRangeText leaves out what is not shown", () => {
  it("skips a collapsed details body, keeps its summary", () => {
    transcript();
    const range = document.createRange();
    range.selectNodeContents(byId("det"));
    expect(renderedRangeText(range)).toBe("CI context");
  });

  it("keeps an open details body", () => {
    transcript();
    (byId("det") as HTMLDetailsElement).open = true;
    const range = document.createRange();
    range.selectNodeContents(byId("det"));
    expect(renderedRangeText(range)).toBe(`CI context${SECRET} body`);
  });

  it("skips sr-only labels, display none, visibility hidden and hidden", () => {
    transcript();
    const range = document.createRange();
    range.selectNodeContents(
      document.querySelector(`[${SELECTABLE_AGENT_RESPONSE_ATTR}="r1"]`)!,
    );
    const text = renderedRangeText(range);
    expect(range.toString()).toContain(SECRET);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("Visible paragraph.");
    expect(text).toContain("bash");
    expect(text).toContain("Bare div text.");
  });

  it("cuts partial text nodes at the range ends", () => {
    transcript();
    const text = byId("p0").firstChild!;
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 7);
    expect(renderedRangeText(range)).toBe("sible");
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

function rangeRects() {
  const rect = new DOMRect(10, 10, 100, 16);
  vi.spyOn(Range.prototype, "getClientRects").mockReturnValue({
    length: 1,
    item: () => rect,
    [Symbol.iterator]: function* () {
      yield rect;
    },
  } as unknown as DOMRectList);
}

function tripleClick(target: Element, selected: Range) {
  target.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, detail: 3, button: 0 }),
  );
  target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  const native = window.getSelection()!;
  native.removeAllRanges();
  native.addRange(selected);
  target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  vi.runAllTimers();
}

describe("the hook never sends hidden text", () => {
  function mount() {
    rangeRects();
    const root = transcript();
    let seen: TranscriptSelection | null = null;
    act(() =>
      reactRoot.render(
        createElement(Probe, { root, onSelection: (s) => (seen = s) }),
      ),
    );
    return () => seen;
  }

  it("a triple-click on a code header keeps the user's own selection", () => {
    const seen = mount();
    act(() => tripleClick(byId("lang"), wordRange("lang")));
    expect(seen()!.text).toBe("bash");
    expect(window.getSelection()!.toString()).toBe("bash");
  });

  it("a triple-click on a summary keeps the summary only", () => {
    const seen = mount();
    act(() => tripleClick(byId("sum"), wordRange("sum")));
    expect(seen()!.text).toBe("CI context");
  });

  it("a selection over a collapsed details and hidden labels drops them", () => {
    const seen = mount();
    const range = document.createRange();
    range.setStart(byId("p0").firstChild!, 0);
    range.setEnd(byId("bare").firstChild!, "Bare div text.".length);
    act(() => tripleClick(byId("p0"), range));
    expect(seen()!.text).not.toContain(SECRET);
    expect(seen()!.text).toContain("Bare div text.");
  });

  it("a triple-click on a clamped user message does not grow", () => {
    const seen = mount();
    const text = byId("user").firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, "line one".length);
    act(() => tripleClick(byId("user"), range));
    expect(seen()!.text).toBe("line one");
  });
});
