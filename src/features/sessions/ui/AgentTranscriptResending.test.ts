// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../model/session";
import { AgentTranscript } from "./AgentTranscript";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// The turn as it stands while its edited prompt is on the way: the old
// prompt and the old answer, in a session that is busy again.
const replaced: Block[] = [
  { id: "user", role: "user", text: "Run the tests", createdAt: 1_000 },
  { id: "answer", role: "assistant", text: "All 12 tests pass." },
];

function render(resendingEdited: boolean) {
  act(() =>
    root.render(
      createElement(AgentTranscript, {
        blocks: replaced,
        busy: true,
        resendingEdited,
      }),
    ),
  );
}

describe("a turn waiting to be replaced by its edited prompt", () => {
  it("says the edited prompt is being sent, not that the old turn is working", () => {
    render(true);
    const line = container.querySelector("[data-live-resending]");
    expect(line?.textContent).toBe("Sending the edited prompt…");
    // No clock counting from the old turn's start.
    expect(container.textContent).not.toMatch(/working for/i);
  });

  it("reads as a running turn again once the resend is over", () => {
    render(true);
    render(false);
    expect(container.querySelector("[data-live-resending]")).toBeNull();
    expect(container.textContent).toMatch(/working/i);
  });
});
