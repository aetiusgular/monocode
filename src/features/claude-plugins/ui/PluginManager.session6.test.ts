// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runClaudePlugin = vi.hoisted(() => vi.fn());
vi.mock("../model/runClaudePlugin", () => ({ runClaudePlugin }));
const listDir = vi.hoisted(() => vi.fn(async () => []));
vi.mock("../../../platform/tauri/fs", () => ({ listDir }));
vi.mock("../../settings/model/sounds", () => ({ playCue: () => false }));

import { parseAvailablePlugins } from "../model/pluginManage";
import { __resetPlugins } from "../model/plugins";
import { PluginsPage } from "./PluginsPage";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  runClaudePlugin.mockReset();
  __resetPlugins();
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
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

/** A reply the size of the Mac's: about 3,600 plugins, 2.2 MB. */
function bigReply(): string {
  const available = Array.from({ length: 3600 }, (_, i) => ({
    pluginId: `plugin-${i}@market-${i % 7}`,
    name: `plugin-${i}`,
    marketplaceName: `market-${i % 7}`,
    description: "d".repeat(520),
  }));
  return JSON.stringify({ installed: [], available });
}

function reply(available: string) {
  runClaudePlugin.mockImplementation(async (args: string[]) => {
    if (args.includes("--available"))
      return { stdout: available, stderr: "", success: true };
    if (args[1] === "marketplace")
      return { stdout: "[]", stderr: "", success: true };
    return { stdout: "[]", stderr: "", success: true };
  });
}

async function browse() {
  await act(async () => {
    root.render(createElement(PluginsPage, { cwd: "/repo" }));
  });
  await settle();
  const browseButton = Array.from(container.querySelectorAll("button")).find(
    (entry) => entry.textContent?.trim() === "Browse marketplaces",
  );
  expect(browseButton).toBeTruthy();
  await act(async () => browseButton!.click());
  await settle();
}

describe("the marketplace list (Mac finding 4.12)", () => {
  it("parses a reply over 2 MB whole", () => {
    const text = bigReply();
    expect(text.length).toBeGreaterThan(2_000_000);
    expect(parseAvailablePlugins(text)).toHaveLength(3600);
  });

  it("throws on a cut reply instead of returning an empty list", () => {
    const text = bigReply();
    expect(() => parseAvailablePlugins(text.slice(0, 1024 * 1024))).toThrow(
      /Could not read the plugin list/,
    );
  });

  it("shows the reason when the list is too large, not 'nothing to install'", async () => {
    runClaudePlugin.mockImplementation(async (args: string[]) => {
      if (args.includes("--available"))
        throw new Error("The plugin list was too large to read.");
      return { stdout: "[]", stderr: "", success: true };
    });
    await browse();
    expect(container.textContent).toContain(
      "The plugin list was too large to read.",
    );
    expect(container.textContent).not.toContain("offer nothing");
  });

  it("shows a parse error for a reply that does not parse", async () => {
    reply('{"installed":[],"available":[{"pluginId":"a@b"');
    await browse();
    expect(container.textContent).toContain("Could not read the plugin list");
    expect(container.textContent).not.toContain("offer nothing");
  });

  it("still says nothing is offered for a real empty list", async () => {
    reply(JSON.stringify({ installed: [], available: [] }));
    await browse();
    expect(container.textContent).toContain("offer nothing");
  });

  it("does not capitalise or correct the marketplace source", async () => {
    reply(JSON.stringify({ installed: [], available: [] }));
    await browse();
    const input = container.querySelector(
      'input[aria-label="Marketplace source"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input!.getAttribute("autocapitalize")).toBe("off");
    expect(input!.getAttribute("autocorrect")).toBe("off");
    expect(input!.getAttribute("spellcheck")).toBe("false");
  });
});
