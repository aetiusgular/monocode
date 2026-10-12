// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listSessions = vi.hoisted(() => vi.fn());
vi.mock("../../../integrations/harness/core/registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../integrations/harness/core/registry")
  >()),
  listHarnessSessions_l1: listSessions,
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return {
    ...original,
    invoke: (command: string, args?: unknown) =>
      command === "list_skills" ? Promise.resolve([]) : original.invoke(command, args),
  };
});
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("../../source-control/hooks/useProjectBranches", () => ({
  useProjectBranchesState: () => ({ branches: undefined, settled: true }),
}));
vi.mock("../../settings/model/sounds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../settings/model/sounds")>()),
  playCue: () => false,
}));

import type { HarnessId } from "../../sessions/model/session";
import { Composer } from "../../sessions/ui/Composer";
import type { PickUpTarget } from "../model/pickUp";
import type { HarnessSessionRow } from "../model/types";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  listSessions.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const CWD = "/Users/me/Projects/scratch dir";

async function renderComposer(options: {
  harness?: HarnessId;
  pickUp?: Partial<PickUpTarget> | null;
  remoteSession?: boolean;
}) {
  const harness = options.harness ?? "codex";
  const pickUp: PickUpTarget | undefined =
    options.pickUp === null
      ? undefined
      : {
          harness,
          cwd: CWD,
          providerAccountId: "local",
          bound: new Map(),
          onPick: vi.fn(async () => {}),
          ...options.pickUp,
        };
  await act(async () =>
    root.render(
      createElement(Composer, {
        focused: true,
        harness,
        model: harness === "claude" ? "claude-sonnet" : "gpt-5",
        runtimeMode: "supervised",
        cwd: CWD,
        executionCwd: CWD,
        sessionId: "s1",
        hideProjectPicker: true,
        hideBranchPicker: true,
        remoteSession: options.remoteSession,
        onFocus: () => {},
        onCwdChange: () => {},
        onModelChange: () => {},
        onRuntimeModeChange: () => {},
        onSubmit: () => {},
        pickUp_l1: pickUp,
      }),
    ),
  );
  await act(async () => {});
  return pickUp;
}

async function menuEntry() {
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Add files or choose a mode"]')!
      .click(),
  );
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-composer-plus] button"),
  ).find((button) => button.textContent?.includes("Pick up a session"));
}

async function openPicker() {
  const entry = await menuEntry();
  await act(async () => entry!.click());
  for (let i = 0; i < 4; i++) await act(async () => {});
  return document.querySelector<HTMLElement>('[role="dialog"][aria-label^="Pick up a"]');
}

const ROWS: HarnessSessionRow[] = [
  { id: "thr_new", title: "Fix the build", updatedAt: Date.now() - 60_000, detail: "recorded with ollama · qwen2.5:7b" },
  { id: "thr_old", title: "Earlier work", updatedAt: Date.now() - 86_400_000 * 3 },
];

describe("Pick up a session in the composer plus menu", () => {
  it("is offered only when the chat gives a target, and never on a remote chat", async () => {
    await renderComposer({});
    expect((await menuEntry())?.textContent).toContain("Continue a Codex session from the terminal");
    act(() => root.unmount());
    root = createRoot(container);
    await renderComposer({ pickUp: null });
    expect(await menuEntry()).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(container);
    await renderComposer({ remoteSession: true });
    expect(await menuEntry()).toBeUndefined();
  });

  it("lists the folder's sessions as the chat's account and marks bound ones", async () => {
    listSessions.mockResolvedValue(ROWS);
    await renderComposer({ pickUp: { bound: new Map([["thr_old", "chat-2"]]) } });
    const picker = (await openPicker())!;
    expect(listSessions).toHaveBeenCalledWith("codex", { cwd: CWD, providerAccountId: "local" });
    const rows = Array.from(picker.querySelectorAll("li"));
    expect(rows.map((row) => row.getAttribute("data-pick-up-session"))).toEqual(["thr_new", "thr_old"]);
    expect(rows[0].textContent).toContain("Fix the build");
    expect(rows[0].textContent).toContain("1 min ago · recorded with ollama · qwen2.5:7b");
    expect(rows[0].textContent).toContain("Pick up");
    expect(rows[1].textContent).toContain("Open chat");
    expect(picker.textContent).toContain("Earlier turns are copied in as text.");
    expect(picker.textContent).toContain("Close the session in the terminal first");
  });

  it("picks a row and closes", async () => {
    listSessions.mockResolvedValue(ROWS);
    const target = await renderComposer({});
    const picker = (await openPicker())!;
    await act(async () => picker.querySelector<HTMLButtonElement>("li button")!.click());
    for (let i = 0; i < 3; i++) await act(async () => {});
    expect(target!.onPick).toHaveBeenCalledWith(ROWS[0]);
    expect(document.querySelector('[aria-label^="Pick up a"]')).toBeNull();
  });

  it("keeps the picker open with the reason when a pick fails", async () => {
    listSessions.mockResolvedValue(ROWS);
    await renderComposer({
      pickUp: { onPick: vi.fn(async () => Promise.reject(new Error("Codex app-server exited"))) },
    });
    const picker = (await openPicker())!;
    await act(async () => picker.querySelector<HTMLButtonElement>("li button")!.click());
    for (let i = 0; i < 3; i++) await act(async () => {});
    const still = document.querySelector<HTMLElement>('[aria-label^="Pick up a"]')!;
    expect(still.querySelector('[role="alert"]')?.textContent).toBe("Codex app-server exited");
    // The rows work again.
    expect(still.querySelector<HTMLButtonElement>("li button")!.disabled).toBe(false);
  });

  it("says when the harness cannot list, or has nothing for the folder", async () => {
    listSessions.mockRejectedValue(new Error("codex not found\non PATH"));
    await renderComposer({});
    let picker = (await openPicker())!;
    expect(picker.querySelector('[role="alert"]')?.textContent).toBe(
      "Codex could not list its sessions: codex not found on PATH",
    );
    act(() => root.unmount());
    root = createRoot(container);
    listSessions.mockResolvedValue([]);
    await renderComposer({ harness: "claude" });
    picker = (await openPicker())!;
    expect(picker.textContent).toContain("No Claude Code sessions recorded in this folder.");
    expect(picker.textContent).toContain("Earlier turns stay with Claude Code and are not shown.");
  });

  it("shows that it is waiting while the harness starts", async () => {
    listSessions.mockReturnValue(new Promise(() => {}));
    await renderComposer({});
    const picker = (await openPicker())!;
    expect(picker.querySelector('[role="status"]')?.textContent).toBe("Asking Codex…");
  });
});
