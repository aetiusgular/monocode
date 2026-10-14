// @vitest-environment happy-dom
import { Storage } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../model/session";
import { saveTranscriptDetail } from "../../settings/model/appearance";
import { resetTranscriptDetailCache } from "../hooks/useTranscriptDetail";
import { AgentTranscript } from "./AgentTranscript";

// Mac 3.10 retest: Everything opened the turn's work but left its
// "Ran 2 tools" group closed.

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

const blocks: Block[] = [
  { id: "user", role: "user", text: "Run the tests" },
  {
    id: "t1",
    role: "tool",
    text: "npm test",
    tool: { kind: "execute", status: "completed", detail: "12 passed" },
  },
  {
    id: "t2",
    role: "tool",
    text: "npm run lint",
    tool: { kind: "execute", status: "completed", detail: "clean" },
  },
  { id: "answer", role: "assistant", text: "All 12 pass." },
];

function render() {
  act(() =>
    root.render(createElement(AgentTranscript, { blocks, busy: false })),
  );
}

const group = () =>
  container.querySelector(
    'button[aria-label^="Hide the steps for"], button[aria-label^="Show the steps for"]',
  );

describe("grouped tool rows follow Transcript detail", () => {
  it("Everything opens the group in a finished turn", () => {
    saveTranscriptDetail("full");
    render();
    expect(group()?.getAttribute("aria-expanded")).toBe("true");
  });

  it("Steps leaves the group closed", () => {
    saveTranscriptDetail("steps");
    render();
    expect(group()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens with a change to Everything while the chat is open", () => {
    saveTranscriptDetail("steps");
    render();
    expect(group()?.getAttribute("aria-expanded")).toBe("false");
    act(() => saveTranscriptDetail("full"));
    expect(group()?.getAttribute("aria-expanded")).toBe("true");
  });

  it("a group closed by hand stays closed when the setting changes", () => {
    saveTranscriptDetail("full");
    render();
    act(() => (group() as HTMLButtonElement).click());
    expect(group()?.getAttribute("aria-expanded")).toBe("false");
    act(() => saveTranscriptDetail("steps"));
    act(() => saveTranscriptDetail("full"));
    expect(group()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("a group opened by hand stays open under Summary", () => {
    saveTranscriptDetail("steps");
    render();
    act(() => (group() as HTMLButtonElement).click());
    act(() => saveTranscriptDetail("summary"));
    // Summary folds the work itself; open it to see the group again.
    const showWork = container.querySelector(
      'button[aria-label="Show the work"]',
    ) as HTMLButtonElement | null;
    if (showWork) act(() => showWork.click());
    expect(group()?.getAttribute("aria-expanded")).toBe("true");
  });
});
