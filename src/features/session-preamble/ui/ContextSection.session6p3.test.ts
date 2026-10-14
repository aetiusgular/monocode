// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextSectionView } from "./ContextSection";
import {
  NEW_CHAT_WITH_THESE,
  STALE_INSTRUCTIONS_TEXT,
} from "./StaleInstructionsLine";
import type { PreambleReport } from "../model/chatContext";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  localStorage.setItem("monocode.sessionPanel.contextCollapsed", "false");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const report: PreambleReport = {
  channel: "native",
  chars: 120,
  budget: 24_576,
  included: ["instructions"],
  omitted: [],
  overBudget: false,
  stale: true,
  at: 0,
};

function render(props: Partial<Parameters<typeof ContextSectionView>[0]>) {
  act(() =>
    root.render(
      createElement(ContextSectionView, {
        report,
        memoryOff: false,
        proposals: [],
        onMemoryOff: () => {},
        onAccept: () => {},
        onReject: () => {},
        ...props,
      }),
    ),
  );
}

describe("finding 2.2: the Context section", () => {
  it("shows the stale state with the new-chat button, and no resend", () => {
    let opened = 0;
    render({ stale: true, onNewChat: () => opened++ });
    const text = container.textContent ?? "";
    expect(text).toContain("Given at launch. 120 of 24,576 characters");
    expect(text).toContain(STALE_INSTRUCTIONS_TEXT);
    expect(text).not.toContain("Send instructions again");
    expect(container.querySelector("[data-context-resend]")).toBeNull();
    const button = container.querySelector(
      "[data-instructions-new-chat]",
    ) as HTMLButtonElement;
    expect(button.textContent).toBe(NEW_CHAT_WITH_THESE);
    act(() => button.click());
    expect(opened).toBe(1);
  });

  it("shows no stale line when nothing changed", () => {
    render({ stale: false, report: { ...report, stale: false } });
    expect(container.textContent).not.toContain(STALE_INSTRUCTIONS_TEXT);
  });

  it("a harness with no native channel still reads 'Sent ahead of the message'", () => {
    render({ report: { ...report, channel: "message", stale: false } });
    expect(container.textContent).toContain("Sent ahead of the message.");
  });
});
