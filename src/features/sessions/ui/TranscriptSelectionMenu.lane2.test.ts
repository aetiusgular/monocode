// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptSelectionMenu } from "./TranscriptSelectionMenu";

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

const selection = {
  text: "Tests run with npm run check",
  rect: { top: 10, left: 10, right: 50, bottom: 20, width: 40, height: 10 },
} as never;

describe("#36: Remember this on a selection", () => {
  it("offers it only when given, and passes the selected text", async () => {
    const remembered: string[] = [];
    act(() =>
      root.render(
        createElement(TranscriptSelectionMenu, {
          selection,
          onRemember: (text: string) => {
            remembered.push(text);
          },
          onDismiss: () => {},
        }),
      ),
    );
    const button = [...document.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Remember this"),
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(remembered).toEqual(["Tests run with npm run check"]);
    act(() =>
      root.render(
        createElement(TranscriptSelectionMenu, {
          selection,
          onDismiss: () => {},
        }),
      ),
    );
    expect(
      [...document.querySelectorAll("button")].some((item) =>
        item.textContent?.includes("Remember this"),
      ),
    ).toBe(false);
  });
});
