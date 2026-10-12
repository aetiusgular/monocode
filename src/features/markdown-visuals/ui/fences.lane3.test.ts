// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (command: string) =>
    command === "sandbox_frame_put" ? "0123456789abcdef0123456789abcdef" : undefined,
  ),
  convertFileSrc: (path: string, protocol: string) =>
    `${protocol}://localhost/${path}`,
}));
vi.mock("@tauri-apps/api/core", () => tauri);

import { HtmlFence } from "./HtmlFence";
import { looksLikeSvg, MAX_SVG_FENCE_BYTES, SvgFence } from "./SvgFence";

let container: HTMLDivElement;
let root: Root;
let blobs: Blob[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  blobs = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    blobs.push(blob as Blob);
    return "blob:monocode/svg";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const source = createElement("pre", { "data-source": "" }, "code");
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle r="4"/></svg>';

describe("SvgFence", () => {
  it("draws a finished svg fence as an image from a typed blob", () => {
    act(() =>
      root.render(createElement(SvgFence, { code: SVG, incomplete: false, source })),
    );
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("blob:monocode/svg");
    expect(blobs[0].type).toBe("image/svg+xml");
    expect(container.querySelector("[data-source]")).toBeNull();
    act(() =>
      (container.querySelector("button") as HTMLButtonElement).click(),
    );
    expect(container.querySelector("[data-source]")).not.toBeNull();
  });

  it("shows the source while the fence still streams", () => {
    act(() =>
      root.render(createElement(SvgFence, { code: "<svg><circ", incomplete: true, source })),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-source]")).not.toBeNull();
  });

  it("falls back to the source when the drawing does not decode", () => {
    act(() =>
      root.render(createElement(SvgFence, { code: SVG, incomplete: false, source })),
    );
    act(() => {
      container.querySelector("img")?.dispatchEvent(new Event("error"));
    });
    expect(container.querySelector("[data-source]")).not.toBeNull();
  });

  it("keeps huge drawings and non-svg text as source", () => {
    const huge = `<svg>${"x".repeat(MAX_SVG_FENCE_BYTES)}</svg>`;
    act(() =>
      root.render(createElement(SvgFence, { code: huge, incomplete: false, source })),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(looksLikeSvg("<html><svg></svg></html>")).toBe(false);
    expect(looksLikeSvg('<?xml version="1.0"?>\n<!-- c --><svg viewBox="0 0 1 1"></svg>')).toBe(true);
  });
});

describe("HtmlFence", () => {
  it("renders in the sandboxed frame only after you click Render", async () => {
    act(() =>
      root.render(
        createElement(HtmlFence, {
          code: "<p>hi</p>",
          incomplete: false,
          allowRender: true,
          source,
        }),
      ),
    );
    expect(container.querySelector("iframe")).toBeNull();
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.textContent).toBe("Render");
    await act(async () => button.click());
    for (let tick = 0; tick < 40 && !container.querySelector("iframe"); tick++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    }
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(container.textContent).toContain("no network");
  });

  it("has no button for content from strangers or while streaming", () => {
    for (const props of [
      { allowRender: false, incomplete: false },
      { allowRender: true, incomplete: true },
    ]) {
      act(() =>
        root.render(
          createElement(HtmlFence, { code: "<p>hi</p>", source, ...props }),
        ),
      );
      expect(container.querySelector("button")).toBeNull();
    }
  });
});
