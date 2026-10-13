// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 3.14: the rendered html frame did not resize from its corner and showed no
// grip. The iframe covers the native CSS resizer, so the frame draws its own.

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) =>
    command === "sandbox_frame_put"
      ? "0123456789abcdef0123456789abcdef"
      : undefined,
  ),
  convertFileSrc: (path: string, protocol: string) =>
    `${protocol}://localhost/${path}`,
}));

import { clampFrameHeight, FRAME_HEIGHT, HtmlFence } from "./HtmlFence";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderFrame() {
  act(() =>
    root.render(
      createElement(HtmlFence, {
        code: "<p>hi</p>",
        incomplete: false,
        allowRender: true,
        source: createElement("pre", null, "<p>hi</p>"),
      }),
    ),
  );
  await act(async () => container.querySelector("button")!.click());
}

const frame = () =>
  container.querySelector<HTMLElement>(".markdown-visual-frame")!;
const grip = () =>
  container.querySelector<HTMLElement>("[data-markdown-visual-grip]")!;

function pointer(type: string, clientY: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientY,
    button: 0,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

describe("html fence frame resizing", () => {
  it("shows a grip in the frame's corner", async () => {
    await renderFrame();
    expect(grip()).not.toBeNull();
    expect(grip().getAttribute("aria-label")).toBe("Resize the rendered HTML");
    expect(frame().style.height).toBe(`${FRAME_HEIGHT.initial}px`);
  });

  it("drags taller and shorter, within the floor and ceiling", async () => {
    vi.stubGlobal("innerHeight", 1000);
    await renderFrame();
    await act(async () => grip().dispatchEvent(pointer("pointerdown", 500)));
    expect(frame().dataset.resizing).toBe("true");
    await act(async () => grip().dispatchEvent(pointer("pointermove", 600)));
    expect(frame().style.height).toBe("460px");
    await act(async () => grip().dispatchEvent(pointer("pointermove", -900)));
    expect(frame().style.height).toBe(`${FRAME_HEIGHT.min}px`);
    await act(async () => grip().dispatchEvent(pointer("pointermove", 5000)));
    expect(frame().style.height).toBe("800px");
    await act(async () => grip().dispatchEvent(pointer("pointerup", 5000)));
    expect(frame().dataset.resizing).toBeUndefined();
    // After release, a move does nothing.
    await act(async () => grip().dispatchEvent(pointer("pointermove", 0)));
    expect(frame().style.height).toBe("800px");
  });

  it("resizes from the keyboard", async () => {
    await renderFrame();
    await act(async () =>
      grip().dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    expect(frame().style.height).toBe(`${FRAME_HEIGHT.initial + 40}px`);
  });

  it("clamps to the floor, 80% of the window and the ceiling", () => {
    expect(clampFrameHeight(10, 1000)).toBe(FRAME_HEIGHT.min);
    expect(clampFrameHeight(5000, 1000)).toBe(800);
    expect(clampFrameHeight(5000, 4000)).toBe(FRAME_HEIGHT.max);
    // A tiny window still keeps the floor.
    expect(clampFrameHeight(500, 50)).toBe(FRAME_HEIGHT.min);
  });

  it("styles the frame to resize and the grip to be seen", () => {
    const css = readFileSync(
      resolve(__dirname, "../../../styles/index.css"),
      "utf8",
    );
    const block = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      expect(start).toBeGreaterThan(-1);
      return css.slice(start, css.indexOf("}", start));
    };
    const frameRule = block(".agent-markdown .markdown-visual-frame");
    expect(frameRule).toContain("resize: vertical");
    expect(frameRule).toContain("overflow: hidden");
    expect(frameRule).toContain("position: relative");
    expect(frameRule).toMatch(/min-height: \d+px/);
    expect(frameRule).toMatch(/max-height:/);
    const gripRule = block(".agent-markdown .markdown-visual-grip");
    expect(gripRule).toContain("position: absolute");
    expect(gripRule).toContain("cursor: ns-resize");
    expect(gripRule).toContain("background");
    expect(
      block(".agent-markdown .markdown-visual-frame[data-resizing] iframe"),
    ).toContain("pointer-events: none");
  });
});
