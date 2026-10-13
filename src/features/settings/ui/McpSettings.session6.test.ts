// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CODEX_PATH_CHANGED, McpSettings } from "./McpSettings";
import { clearMcpSettingsCache } from "../model/mcpSettingsCache";
import { saveProviderBinaryPath } from "../../providers/model/providerBinaryPaths";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: async () => true }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  clearMcpSettingsCache();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) =>
    command === "mcp_discover"
      ? [
          {
            provider: "codex",
            name: "old-home-server",
            scope: "user",
            configPath: "/Users/me/.codex/config.toml",
            transport: "stdio",
          },
        ]
      : undefined,
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  clearMcpSettingsCache();
  container.remove();
  vi.unstubAllGlobals();
});

it("Mac fix 4.5: says nothing while the Codex path in use is the configured one", async () => {
  await act(async () =>
    root.render(createElement(McpSettings, { cwd: "/Users/me/my repo" })),
  );
  expect(container.textContent).not.toContain(CODEX_PATH_CHANGED);
});

it("Mac fix 4.5: says a restart lists the new Codex home's servers", async () => {
  // The path editor saved a wrapper script home; the app still runs the old one.
  saveProviderBinaryPath("codex", "/Users/me/codex-local-bin/codex");
  await act(async () =>
    root.render(createElement(McpSettings, { cwd: "/Users/me/my repo" })),
  );
  expect(
    container.querySelector("[data-codex-path-changed]")?.textContent,
  ).toBe(
    "The Codex path changed. Restart MonoCode to list that home's servers.",
  );
  expect(container.textContent).toContain("old-home-server");
});
