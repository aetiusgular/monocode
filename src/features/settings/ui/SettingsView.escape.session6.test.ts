// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { SettingsView } from "./SettingsView";
import { rememberNotificationProjects } from "../../notifications/model/notificationProjects";
import {
  SETTINGS_INDEX,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "../model/settings";
import {
  providerAccounts,
  saveProviderAccount,
} from "../../providers/model/providerAccounts";
import {
  clearCachedRateLimits,
  setCachedRateLimits,
} from "../../providers/model/rateLimitsCache";
import { HARNESSES, HARNESS_TITLE } from "../../sessions/model/session";
import { saveMaskEmails, saveShowRemainingUsage } from "../model/displayPrefs";
import {
  createMono,
  findMono,
  monoLook,
  updateMono,
} from "../../monos/model/mono";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
  }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true) }));
vi.mock("../../../integrations/harness/core/availability", () => ({
  isHarnessAvailable: (id: string) => id === "claude" || id === "cursor",
  hasProbedHarnessAvailability: () => true,
  getHarnessAvailabilitySnapshot: () => 0,
  subscribeHarnessAvailability: () => () => {},
  probeHarnessAvailability: async () => {},
  harnessUnavailableHint: () => "",
}));

let container: HTMLDivElement;
let root: Root;
let onSelectSection: ReturnType<typeof vi.fn>;

function mockLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  });
}

async function render(
  section: SettingsSectionId,
  options: Partial<ComponentProps<typeof SettingsView>> = {},
) {
  await act(async () =>
    root.render(
      createElement(SettingsView, {
        section,
        cwd: "/repo",
        sessions: [],
        onClose: vi.fn(),
        onSelectSection,
        onOpenSession: vi.fn(),
        onArchiveSession: vi.fn(),
        onDeleteSession: vi.fn(),
        onOpenWhatsNew: vi.fn(),
        ...options,
      }),
    ),
  );
}

function renderedSettingIds(): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-setting-id]"),
    (node) => node.dataset.settingId!,
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mockLocalStorage();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onSelectSection = vi.fn();
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearCachedRateLimits();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// 2.10: Escape in a Settings text field (dismissing a macOS autocorrect
// suggestion) closed Settings.
describe("Escape in Settings", () => {
  it("blurs a focused text field and keeps Settings open", async () => {
    const onClose = vi.fn();
    await render("environment", { onClose });
    const input = container.querySelector<HTMLInputElement>("[data-env-name]");
    expect(input).not.toBeNull();
    input!.focus();
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => input!.dispatchEvent(event));
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(input);
  });

  it("closes Settings from anywhere else", async () => {
    const onClose = vi.fn();
    await render("environment", { onClose });
    await act(async () =>
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
