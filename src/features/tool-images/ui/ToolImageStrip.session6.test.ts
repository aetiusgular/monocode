// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../sessions/model/session";

// 0.6: on Mac Chromium the hover preview never appeared. The thumbnail
// changes width as its image loads, which fires a leave (and a move at the
// same spot) while the pointer is still on it. Leave events no longer close
// the preview; only a real move off the thumbnail and its preview does.

vi.mock("./useToolImage", () => ({
  useToolImageThumbnail: () => ({ url: undefined, failed: false }),
  useToolImage: () => ({ url: undefined, shownPath: undefined }),
}));
vi.mock("./toolImageGalleryStore", () => ({
  openToolImageGallery: vi.fn(),
}));

import { ToolImageStrip } from "./ToolImageStrip";

let container: HTMLDivElement;
let root: Root;

const block: Block = {
  id: "call",
  role: "tool",
  text: "Screenshot",
  tool: { kind: "mcp", status: "completed" },
  toolImages: [
    { id: "img-1", path: "/x/1.png", mimeType: "image/png", size: 10 },
    { id: "img-2", path: "/x/2.png", mimeType: "image/png", size: 10 },
  ],
} as Block;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const thumb = (id: string) =>
  container.querySelector<HTMLElement>(`[data-tool-image="${id}"]`)!;
const preview = () => document.querySelector("[data-tool-image-preview]");

function place(element: HTMLElement, left: number, top: number) {
  element.getBoundingClientRect = () =>
    ({
      left,
      top,
      right: left + 40,
      bottom: top + 40,
      width: 40,
      height: 40,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function fire(target: EventTarget, type: string, x: number, y: number) {
  const Ctor = type.startsWith("pointer") ? MouseEvent : MouseEvent;
  target.dispatchEvent(
    new Ctor(type, { bubbles: type !== "mouseenter", clientX: x, clientY: y }),
  );
}

async function mount() {
  await act(async () =>
    root.render(createElement(ToolImageStrip, { block, label: "Screenshot" })),
  );
  place(thumb("img-1"), 100, 100);
  place(thumb("img-2"), 150, 100);
}

async function wait(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe("tool image hover preview", () => {
  it("opens after a rest even when a leave fires as the image loads", async () => {
    await mount();
    await act(async () => fire(thumb("img-1"), "mouseover", 110, 110));
    await act(async () => fire(thumb("img-1"), "pointerover", 110, 110));
    // Layout shift: leave events at the same spot, the pointer has not moved.
    await act(async () => fire(thumb("img-1"), "pointerout", 110, 110));
    await act(async () => fire(thumb("img-1"), "mouseout", 110, 110));
    await act(async () => fire(window, "mousemove", 110, 110));
    await wait(200);
    expect(preview()?.getAttribute("data-tool-image-preview")).toBe("img-1");
    // Another fake move at the same place keeps it open.
    await act(async () => fire(window, "pointermove", 110, 110));
    expect(preview()).not.toBeNull();
  });

  it("stays open while the pointer moves within the thumbnail", async () => {
    await mount();
    await act(async () => fire(thumb("img-1"), "pointerover", 105, 105));
    await wait(200);
    await act(async () => fire(window, "pointermove", 130, 135));
    expect(preview()).not.toBeNull();
  });

  it("closes when the pointer moves off the thumbnail and the preview", async () => {
    await mount();
    await act(async () => fire(thumb("img-1"), "pointerover", 110, 110));
    await wait(200);
    expect(preview()).not.toBeNull();
    await act(async () => fire(window, "pointermove", 600, 700));
    expect(preview()).toBeNull();
  });

  it("does not open if the pointer leaves before the rest ends", async () => {
    await mount();
    await act(async () => fire(thumb("img-1"), "pointerover", 110, 110));
    await act(async () => fire(window, "pointermove", 600, 700));
    await wait(200);
    expect(preview()).toBeNull();
  });

  it("closes when the pointer leaves the window", async () => {
    await mount();
    await act(async () => fire(thumb("img-1"), "pointerover", 110, 110));
    await wait(200);
    await act(async () => fire(thumb("img-1"), "mouseout", -1, 110));
    expect(preview()).toBeNull();
  });

  it("moves to the next thumbnail", async () => {
    await mount();
    await act(async () => fire(thumb("img-1"), "pointerover", 110, 110));
    await wait(200);
    await act(async () => fire(thumb("img-2"), "pointerover", 160, 110));
    await wait(200);
    expect(preview()?.getAttribute("data-tool-image-preview")).toBe("img-2");
  });
});
