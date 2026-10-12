// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runDockerMcp = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/tauri/dockerMcp", () => ({ runDockerMcp }));

import { ConnectorToolsSection, ToolLoadingSetting } from "./ConnectorTools";

let container: HTMLDivElement;
let root: Root;
let allow: string[] | null;

const showJson = () =>
  JSON.stringify({
    servers: [
      {
        type: "image",
        tools: allow,
        snapshot: {
          server: {
            name: "github",
            tools: [
              { name: "create_issue", description: "Open an issue" },
              { name: "search_code", description: "" },
            ],
          },
        },
      },
    ],
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  allow = null;
  runDockerMcp.mockReset();
  runDockerMcp.mockImplementation(async (args: string[]) => {
    if (args[2] === "tools") {
      const tool = args[5].split(".")[1];
      allow = (allow ?? ["create_issue", "search_code"]).filter(
        (name) => name !== tool,
      );
    }
    return { stdout: showJson(), stderr: "", success: true, docker: "docker" };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

describe("connector tools", () => {
  it("lists the tools with switches and turns one off for good", async () => {
    await act(async () => {
      root.render(
        createElement(ConnectorToolsSection, {
          profileId: "monocode_github",
          server: "github",
        }),
      );
    });
    await settle();
    expect(container.textContent).toContain("All 2 tools on");
    const row = container.querySelector('[data-tool="search_code"]')!;
    await act(async () =>
      (row.querySelector('[role="switch"]') as HTMLElement).click(),
    );
    await settle();
    expect(runDockerMcp.mock.calls.map((call) => call[0].join(" "))).toContain(
      "mcp profile tools monocode_github --disable github.search_code",
    );
    expect(container.textContent).toContain("1 of 2 tools on");
    expect(
      container
        .querySelector('[data-tool="search_code"]')
        ?.getAttribute("data-tool-state"),
    ).toBe("off");
  });

  it("saves the Claude Code loading choice", async () => {
    await act(async () => {
      root.render(createElement(ToolLoadingSetting));
    });
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "upfront";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(localStorage.getItem("monocode.claudeToolLoading.v1")).toBe(
      "upfront",
    );
    expect(
      container
        .querySelector("[data-tool-loading]")
        ?.getAttribute("data-tool-loading"),
    ).toBe("upfront");
  });
});
