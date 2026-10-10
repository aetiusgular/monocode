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

const user: Block = { id: "user", role: "user", text: "Run the tests" };

function render(blocks: Block[], busy = true) {
  act(() => root.render(createElement(AgentTranscript, { blocks, busy })));
  // A turn with an answer under its work folds the work away.
  const show = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Show the work"]',
  );
  if (show) act(() => show.click());
}

function toggle(label: string) {
  return container.querySelector<HTMLButtonElement>(
    `button[aria-label$="details for ${label}"]`,
  );
}

describe("a tool row's request and response", () => {
  it("keeps a finished command's output folded until the row is opened", () => {
    render([
      user,
      {
        id: "tests",
        role: "tool",
        text: "npm test",
        tool: {
          kind: "execute",
          status: "completed",
          detail: "12 passed\n0 failed",
        },
      },
    ]);
    const open = toggle("npm test");
    expect(open?.getAttribute("aria-label")).toBe("Show details for npm test");
    expect(open?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("12 passed");

    act(() => open?.click());
    expect(toggle("npm test")?.getAttribute("aria-expanded")).toBe("true");
    const detail = container.querySelector("[data-tool-call-detail]");
    expect(detail?.getAttribute("data-tool-call-detail")).toBe("settled");
    expect(
      detail?.querySelector('section[aria-label="Request"] pre')?.textContent,
    ).toBe("npm test");
    expect(
      detail?.querySelector('section[aria-label="Response"] pre')?.textContent,
    ).toBe("12 passed\n0 failed");

    act(() => toggle("npm test")?.click());
    expect(container.querySelector("[data-tool-call-detail]")).toBeNull();
  });

  it("opens from the row itself as well as from its chevron", () => {
    render([
      user,
      {
        id: "tests",
        role: "tool",
        text: "npm test",
        tool: { kind: "execute", status: "completed", detail: "ok" },
      },
    ]);
    const row = container.querySelector<HTMLElement>(
      '[aria-label="Tool call: npm test"]',
    );
    act(() => row?.querySelector<HTMLElement>(".cursor-pointer")?.click());
    expect(container.querySelector("[data-tool-call-detail]")).not.toBeNull();
  });

  it("shows a running command's output so far, and follows it", () => {
    const running = (detail?: string): Block[] => [
      user,
      {
        id: "tests",
        role: "tool",
        text: "npm test",
        tool: { kind: "execute", status: "in_progress", detail },
      },
    ];
    render(running());
    act(() => toggle("npm test")?.click());
    const section = () =>
      container.querySelector('section[aria-label="Output so far"]');
    expect(
      container
        .querySelector("[data-tool-call-detail]")
        ?.getAttribute("data-tool-call-detail"),
    ).toBe("running");
    expect(section()?.textContent).toContain("Nothing printed yet.");

    // The same row, a moment later: the output streams into the open detail.
    act(() =>
      root.render(
        createElement(AgentTranscript, {
          blocks: running("RUN v3\n ✓ a.test.ts"),
          busy: true,
        }),
      ),
    );
    expect(section()?.querySelector("pre")?.textContent).toBe(
      "RUN v3\n ✓ a.test.ts",
    );
  });

  it("says a command was stopped once its turn is over", () => {
    const blocks: Block[] = [
      user,
      {
        id: "tests",
        role: "tool",
        text: "npm test",
        tool: { kind: "execute", status: "in_progress", detail: "3 passed" },
      },
    ];
    render(blocks);
    act(() => toggle("npm test")?.click());
    expect(
      container
        .querySelector("[data-tool-call-detail]")
        ?.getAttribute("data-tool-call-detail"),
    ).toBe("running");

    // Stop: the session is no longer busy and the call never finished.
    render(blocks, false);
    const detail = container.querySelector("[data-tool-call-detail]");
    expect(detail?.getAttribute("data-tool-call-detail")).toBe("stopped");
    expect(detail?.textContent).not.toContain("Output so far");
    expect(
      detail?.querySelector(
        'section[aria-label="Output before it stopped"] pre',
      )?.textContent,
    ).toBe("3 passed");
  });

  it("gives a call that returned nothing no chevron", () => {
    render([
      user,
      {
        id: "add",
        role: "tool",
        text: "git add .",
        tool: { kind: "execute", status: "completed" },
      },
    ]);
    expect(
      container.querySelector('[aria-label="Tool call: git add ."]'),
    ).not.toBeNull();
    expect(container.querySelector("[data-tool-call-toggle]")).toBeNull();
  });

  it("leaves a failed call to its error disclosure", () => {
    render([
      user,
      {
        id: "dev",
        role: "tool",
        text: "npm run dev",
        tool: { kind: "execute", status: "failed", detail: "listen EPERM" },
      },
    ]);
    expect(container.querySelector("[data-tool-call-toggle]")).toBeNull();
    expect(
      container.querySelector('button[aria-label^="Show error details for"]'),
    ).not.toBeNull();
  });
});

describe("the live status line", () => {
  const status = () =>
    container.querySelector("[data-live-doing]")?.textContent ?? null;

  it("names the command in flight while the work is folded", () => {
    act(() =>
      root.render(
        createElement(AgentTranscript, {
          blocks: [
            user,
            { id: "say", role: "assistant", text: "Running the suite." },
            {
              id: "tests",
              role: "tool",
              text: "npm test",
              tool: { kind: "execute", status: "in_progress" },
            },
          ],
          busy: true,
          visible: true,
        }),
      ),
    );
    expect(status()).toContain("Running npm test");
    expect(
      container.querySelector("[data-live-doing]")?.getAttribute("title"),
    ).toBe("Running npm test");
  });

  it("names nothing once the call has landed", () => {
    act(() =>
      root.render(
        createElement(AgentTranscript, {
          blocks: [
            user,
            {
              id: "tests",
              role: "tool",
              text: "npm test",
              tool: { kind: "execute", status: "completed", detail: "ok" },
            },
          ],
          busy: true,
          visible: true,
        }),
      ),
    );
    expect(status()).toBeNull();
  });
});
