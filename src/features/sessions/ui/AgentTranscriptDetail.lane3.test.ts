// @vitest-environment happy-dom
import { Storage } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../model/session";
import { saveTranscriptDetail } from "../../settings/model/appearance";
import { resetTranscriptDetailCache } from "../hooks/useTranscriptDetail";
import { AgentTranscript } from "./AgentTranscript";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", new Storage());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  resetTranscriptDetailCache();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// A finished turn: work, then an answer, so the work folds by default.
const blocks: Block[] = [
  { id: "user", role: "user", text: "Run the tests" },
  {
    id: "tests",
    role: "tool",
    text: "npm test",
    tool: { kind: "execute", status: "completed", detail: "12 passed\n0 failed" },
  },
  { id: "answer", role: "assistant", text: "All 12 pass." },
];

function render() {
  act(() =>
    root.render(createElement(AgentTranscript, { blocks, busy: false })),
  );
}

const showWork = () =>
  container.querySelector('button[aria-label="Show the work"]');
const rowToggle = () =>
  container.querySelector('button[aria-label$="details for npm test"]');

describe("default transcript detail (#48)", () => {
  it("summary keeps a finished turn's work folded, as before", () => {
    render();
    expect(showWork()).not.toBeNull();
    expect(container.textContent).not.toContain("12 passed");
  });

  it("steps opens the work but not each row", () => {
    saveTranscriptDetail("steps");
    render();
    expect(showWork()).toBeNull();
    expect(rowToggle()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("everything opens the work and each row", () => {
    saveTranscriptDetail("full");
    render();
    expect(rowToggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("12 passed");
  });

  it("a fold you close stays closed under any default", () => {
    saveTranscriptDetail("full");
    render();
    act(() => (rowToggle() as HTMLButtonElement).click());
    expect(rowToggle()?.getAttribute("aria-expanded")).toBe("false");
    render();
    expect(rowToggle()?.getAttribute("aria-expanded")).toBe("false");
  });
});
