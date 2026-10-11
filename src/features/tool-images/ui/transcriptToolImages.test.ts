// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../sessions/model/session";
import type { ToolImageRef } from "../model/toolImages";

vi.mock("../../../platform/tauri/fs", async (original) => ({
  ...(await original<typeof import("../../../platform/tauri/fs")>()),
  readBinaryFile: vi.fn(
    async () =>
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ),
}));

const { AgentTranscript } = await import("../../sessions/ui/AgentTranscript");

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
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:thumbnail");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function image(id: string): ToolImageRef {
  return {
    id,
    path: `/data/generated-images/${id}.png`,
    mimeType: "image/png",
    size: 2048,
  };
}

const user: Block = { id: "user", role: "user", text: "Check the page" };

function render(blocks: Block[], busy = true) {
  act(() => root.render(createElement(AgentTranscript, { blocks, busy })));
  const show = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Show the work"]',
  );
  if (show) act(() => show.click());
}

describe("tool-result images in the transcript", () => {
  it("puts the thumbnails under the tool call's own row", () => {
    render([
      user,
      {
        id: "shot",
        role: "tool",
        text: "Take a screenshot",
        tool: {
          callId: "toolu_shot",
          kind: "other",
          status: "completed",
          detail: "Took the screenshot.",
        },
        toolImages: [image("toolu_shot:0"), image("toolu_shot:1")],
      },
    ]);
    const row = container.querySelector<HTMLElement>(
      '[aria-label="Tool call: Take a screenshot"]',
    );
    expect(row).not.toBeNull();
    const strip = container.querySelector<HTMLElement>("[data-tool-images]");
    expect(strip).not.toBeNull();
    // A sibling right after the row: not inside the part that opens details.
    expect(row!.nextElementSibling).toBe(strip);
    expect(strip!.querySelectorAll("[data-tool-image]")).toHaveLength(2);
    expect(
      strip!.querySelector("[data-tool-image]")?.getAttribute("aria-label"),
    ).toBe("Open image 1 of 2 from Take a screenshot");
  });

  it("adds nothing to a tool call that returned text only", () => {
    render([
      user,
      {
        id: "tests",
        role: "tool",
        text: "npm test",
        tool: { kind: "execute", status: "completed", detail: "12 passed" },
      },
    ]);
    expect(
      container.querySelector('[aria-label="Tool call: npm test"]'),
    ).not.toBeNull();
    expect(container.querySelector("[data-tool-images]")).toBeNull();
  });

  it("shows a subagent's images on the subagent's row", () => {
    render([
      user,
      {
        id: "agent",
        role: "tool",
        text: "Check the mobile layout",
        tool: {
          callId: "toolu_agent",
          title: "Check the mobile layout",
          kind: "agent",
          status: "in_progress",
        },
        agentRun: {
          name: "Check the mobile layout",
          steps: [
            {
              id: "toolu_inner",
              kind: "tool",
              text: "Take a screenshot",
              status: "completed",
            },
          ],
        },
        toolImages: [image("toolu_inner:0")],
      },
    ]);
    const thumbnails = container.querySelectorAll("[data-tool-image]");
    expect(thumbnails).toHaveLength(1);
    expect(thumbnails[0].getAttribute("aria-label")).toBe(
      "Open image 1 of 1 from Check the mobile layout",
    );
  });
});
