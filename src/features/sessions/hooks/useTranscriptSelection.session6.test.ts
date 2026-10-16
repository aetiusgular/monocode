// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rangeWithinOneResponse } from "./useTranscriptSelection";
import {
  SELECTABLE_AGENT_RESPONSE_ATTR,
  validateTranscriptSelection,
} from "../model/transcriptSelection";
import { rememberedNotice } from "../../project-memory/model/remember";

vi.mock("../../settings/model/sounds", () => ({ playCue: () => undefined }));

// Mac 2.8: the selection menu came up for a drag but not for a triple-click,
// and "Remember this" saved with no word in the chat.

function transcript() {
  const root = document.createElement("div");
  root.innerHTML = `
    <div ${SELECTABLE_AGENT_RESPONSE_ATTR}="r1"><p id="p1">Use pnpm, not npm, in this repo.</p></div>
    <div id="after"><p id="p2">   </p><button id="b">Copy</button></div>
    <div ${SELECTABLE_AGENT_RESPONSE_ATTR}="r2"><p id="p3">Second reply.</p></div>`;
  document.body.append(root);
  return root;
}

const idOf = (node: Node) =>
  (node instanceof Element ? node : node.parentElement)
    ?.closest(`[${SELECTABLE_AGENT_RESPONSE_ATTR}]`)
    ?.getAttribute(SELECTABLE_AGENT_RESPONSE_ATTR) ?? null;

function menuText(range: Range, root: HTMLElement) {
  const inner = rangeWithinOneResponse(range, root);
  return validateTranscriptSelection({
    text: inner.toString(),
    collapsed: inner.collapsed,
    anchorResponseId: idOf(inner.startContainer),
    focusResponseId: idOf(inner.endContainer),
  });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("a triple-click selection in a reply", () => {
  it("gets the menu when the range ends just past the reply", () => {
    const root = transcript();
    const range = document.createRange();
    range.setStart(document.getElementById("p1")!.firstChild!, 0);
    // WebKit ends a paragraph selection at the start of the next block.
    range.setEnd(document.getElementById("p2")!, 0);
    expect(menuText(range, root)).toBe("Use pnpm, not npm, in this repo.");
  });

  it("gets the menu for a drag inside the reply, as before", () => {
    const root = transcript();
    const text = document.getElementById("p1")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 4);
    range.setEnd(text, 8);
    expect(menuText(range, root)).toBe("pnpm");
  });

  it("gets no menu for a selection across two replies", () => {
    const root = transcript();
    const range = document.createRange();
    range.setStart(document.getElementById("p1")!.firstChild!, 0);
    range.setEnd(document.getElementById("p3")!.firstChild!, 3);
    expect(menuText(range, root)).toBeNull();
  });

  it("gets no menu when the range runs into text outside the reply", () => {
    const root = transcript();
    const range = document.createRange();
    range.setStart(document.getElementById("p1")!.firstChild!, 0);
    range.setEnd(document.getElementById("b")!.firstChild!, 4);
    expect(menuText(range, root)).toBeNull();
  });
});

describe("Remember this confirms in the chat", () => {
  it("names the project", () => {
    expect(rememberedNotice("/Users/tony/my proj", { added: true })).toBe(
      "Remembered for my proj.",
    );
    expect(rememberedNotice("/Users/tony/-dash", { added: false })).toBe(
      "Already remembered for -dash.",
    );
  });

  it("renders as a status line", async () => {
    const { RememberNotice } = await import("../ui/AgentTranscript");
    const html = renderToStaticMarkup(
      createElement(RememberNotice, { text: "Remembered for my proj." }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Remembered for my proj.");
  });
});
