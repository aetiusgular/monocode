// @vitest-environment happy-dom
import type * as TauriCore from "@tauri-apps/api/core";
import { Storage } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  calls: [] as Array<[string, Record<string, unknown> | undefined]>,
  file: "",
}));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof TauriCore>()),
  convertFileSrc: (path: string, protocol: string) =>
    `${protocol}://localhost/${path}`,
  invoke: async (command: string, args?: Record<string, unknown>) => {
    bridge.calls.push([command, args]);
    if (command === "read_text_file") return bridge.file;
    if (command === "stat_files") return [];
    if (command === "git_diff_files") return { files: [] };
    if (command === "sandbox_frame_put")
      return "0123456789abcdef0123456789abcdef";
    return undefined;
  },
}));

import { FileEditor } from "./FileEditor";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", new Storage());
  bridge.calls = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function open(path: string) {
  await act(async () => {
    root.render(
      createElement(FileEditor, {
        path,
        cwd: "/Users/ada/project",
        active: true,
        onDirtyChange: () => {},
      }),
    );
  });
  // State set by a resolved promise inside one act() only lands when that
  // act() ends, so poll with a fresh act() each time.
  for (let tick = 0; tick < 40 && !container.querySelector("iframe"); tick++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
  expect(container.querySelector("iframe")).not.toBeNull();
}

it("opens an HTML file as a sandboxed preview with its source a tab away", async () => {
  bridge.file = "<!doctype html><p>Report</p><script>1</script>";
  await open("/Users/ada/project/out/my report.html");
  const frame = container.querySelector("iframe");
  expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame?.getAttribute("title")).toBe("Preview of my report.html");
  const put = bridge.calls.find(([command]) => command === "sandbox_frame_put");
  expect(String(put?.[1]?.html)).toContain("<p>Report</p>");
  const tabs = [...container.querySelectorAll('[role="tab"]')];
  expect(tabs.map((tab) => tab.textContent)).toEqual(["Preview", "Source"]);
});

it("stops the page when you switch to the source", async () => {
  bridge.file = "<p>x</p>";
  await open("/Users/ada/project/index.htm");
  const source = [...container.querySelectorAll('[role="tab"]')].find(
    (tab) => tab.textContent === "Source",
  ) as HTMLButtonElement;
  await act(async () => source.click());
  expect(container.querySelector("iframe")).toBeNull();
  expect(
    bridge.calls.some(([command]) => command === "sandbox_frame_release"),
  ).toBe(true);
});
