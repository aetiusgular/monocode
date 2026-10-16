// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    throw new Error(command);
  }),
}));

import {
  REMEMBER_MAX,
  rememberableText,
} from "../../project-memory/model/remember";
import {
  SELECTION_MENU_FAILURE_WIDTH,
  TranscriptSelectionMenu,
} from "./TranscriptSelectionMenu";

// Mac 2.8 (15 Oct): Remember this on about 1,900 characters showed only
// "Could not remember" and the popover cut off the rest of the reason.

let host: HTMLDivElement;
let root: Root;

/** Heights as a browser would measure them: the frame grows with the reason. */
const MENU_HEIGHT = 110;
const MENU_WITH_REASON_HEIGHT = 190;

/** happy-dom's own offsetHeight, put back after each test. */
const realOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetHeight",
);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // happy-dom lays nothing out. A frame reports its content's height, held
  // to its max-height when one is set, as a browser does.
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.hasAttribute("data-popover-side")) return 0;
      const natural = this.querySelector('[role="alert"]')
        ? MENU_WITH_REASON_HEIGHT
        : MENU_HEIGHT;
      const cap = parseFloat(this.style.maxHeight);
      return Number.isNaN(cap) ? natural : Math.min(natural, cap);
    },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  if (realOffsetHeight)
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetHeight",
      realOffsetHeight,
    );
  else delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
  vi.unstubAllGlobals();
});

/** The selection's first line sits 130px down: room above for the menu only. */
const rect = new DOMRect(200, 130, 300, 16);

function renderMenu(text: string, onRemember: (text: string) => void) {
  act(() =>
    root.render(
      createElement(TranscriptSelectionMenu, {
        selection: { text, rect },
        onRemember,
        onDismiss: () => undefined,
      }),
    ),
  );
}

async function pressRemember() {
  const button = [...document.querySelectorAll("button")].find(
    (item) => item.textContent === "Remember this",
  )!;
  await act(async () => {
    button.click();
  });
}

const menu = () => document.querySelector<HTMLElement>('[role="toolbar"]')!;
/** The positioned frame around the menu. */
const frame = () => menu().parentElement!;
const alertText = () =>
  document.querySelector('[role="alert"]')?.textContent ?? null;

describe("Remember this shows the whole reason it saved nothing", () => {
  it("names the length and the limit in short sentences", () => {
    expect(REMEMBER_MAX).toBe(980);
    expect(() => rememberableText("x".repeat(1912))).toThrow(
      new Error(
        "This selection is 1,912 characters. A memory entry holds at most 980.",
      ),
    );
  });

  it("saves exactly 980 characters and refuses 981", () => {
    expect(rememberableText("x".repeat(980))).toHaveLength(980);
    expect(() => rememberableText("x".repeat(981))).toThrow(
      new Error(
        "This selection is 981 characters. A memory entry holds at most 980.",
      ),
    );
  });

  it("closes the menu with no reason shown for 980 characters", async () => {
    const remembered: string[] = [];
    const dismissed = vi.fn();
    act(() =>
      root.render(
        createElement(TranscriptSelectionMenu, {
          selection: { text: "x".repeat(980), rect },
          onRemember: (text: string) => {
            remembered.push(rememberableText(text));
          },
          onDismiss: dismissed,
        }),
      ),
    );
    await pressRemember();
    expect(remembered).toEqual(["x".repeat(980)]);
    expect(dismissed).toHaveBeenCalled();
    expect(alertText()).toBeNull();
  });

  it("shows the whole reason for 981 characters", async () => {
    renderMenu("x".repeat(981), (text) => void rememberableText(text));
    await pressRemember();
    expect(alertText()).toBe(
      "Could not remember this. This selection is 981 characters. A memory entry holds at most 980.",
    );
  });

  it("wraps the reason at a readable width and never caps the menu's height", async () => {
    renderMenu("x".repeat(1912), (text) => void rememberableText(text));
    expect(frame().style.width).not.toBe(`${SELECTION_MENU_FAILURE_WIDTH}px`);
    await pressRemember();
    expect(alertText()).toBe(
      "Could not remember this. This selection is 1,912 characters. A memory entry holds at most 980.",
    );
    const reason = document.querySelector('[role="alert"]')!;
    expect(reason.className).toContain("whitespace-normal");
    expect(reason.className).not.toMatch(/truncate|nowrap|line-clamp/);
    expect(frame().style.width).toBe(`${SELECTION_MENU_FAILURE_WIDTH}px`);
    // No max-height on the frame or the menu, so nothing is clipped.
    expect(frame().style.maxHeight).toBe("");
    expect(menu().style.maxHeight).toBe("");
  });

  it("moves below the selection when the reason does not fit above it", async () => {
    renderMenu("x".repeat(1912), (text) => void rememberableText(text));
    // The three-line menu fits in the 116px above the selection's first line.
    expect(frame().getAttribute("data-popover-side")).toBe("top");
    await pressRemember();
    // With the reason it is 190px: measured whole, it goes below instead of
    // keeping its first line and cutting the rest.
    expect(frame().getAttribute("data-popover-side")).toBe("bottom");
    expect(frame().style.top).toBe(`${rect.bottom + 6}px`);
    expect(frame().offsetHeight).toBe(MENU_WITH_REASON_HEIGHT);
  });

  it("starts clear again for the next selection", async () => {
    renderMenu("x".repeat(1912), (text) => void rememberableText(text));
    await pressRemember();
    expect(alertText()).not.toBeNull();
    act(() =>
      root.render(
        createElement(TranscriptSelectionMenu, {
          selection: null,
          onRemember: () => undefined,
          onDismiss: () => undefined,
        }),
      ),
    );
    renderMenu("short", () => undefined);
    expect(alertText()).toBeNull();
    expect(frame().style.width).not.toBe(`${SELECTION_MENU_FAILURE_WIDTH}px`);
  });
});
