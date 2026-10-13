// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { TurnRewindMenu, MENU_CHAT_REWIND_LIMIT_MS } = await import(
  "./TurnRewindMenu"
);
import type { RewindOptions } from "../model/rewind";
import type { TurnRewind } from "../model/turnRewind";

let container: HTMLDivElement;
let root: Root;

const options: RewindOptions = {
  blockId: "u2",
  turnStart: 2,
  turnEnd: 4,
  isLastTurn: false,
  laterPrompts: 1,
  chat: { enabled: true, providerTurnId: "uuid-end-of-turn-1" },
  files: { enabled: false, reason: "No checkpoint was taken before this turn" },
  fork: { enabled: true, plan: { mode: "native", harness: "claude", at: "x" } },
};

function rewind(onRewindChat: TurnRewind["onRewindChat"]): TurnRewind {
  return {
    sessionId: "s1",
    cwd: "/repo",
    optionsFor: () => options,
    onRewindChat,
    onFork: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  invoke.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openConfirm(props: TurnRewind) {
  await act(async () => {
    root.render(createElement(TurnRewindMenu, { rewind: props, blockId: "u2" }));
  });
  await act(async () =>
    container.querySelector<HTMLButtonElement>("[data-turn-rewind]")!.click(),
  );
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[data-rewind-action="chat"]')!
      .click(),
  );
  expect(text()).toContain("Take back this prompt and the 1 prompt after it");
}

const text = () =>
  document.querySelector("[data-turn-rewind-menu]")?.textContent ?? "";
const confirmButton = () =>
  document.querySelector<HTMLButtonElement>("[data-rewind-confirm]");

describe("TurnRewindMenu chat rewind (session 6)", () => {
  it("closes once the rewind succeeds", async () => {
    const onRewindChat = vi.fn(async () => undefined);
    await openConfirm(rewind(onRewindChat));
    await act(async () => confirmButton()!.click());
    expect(onRewindChat).toHaveBeenCalledWith("u2");
    expect(document.querySelector("[data-turn-rewind-menu]")).toBeNull();
  });

  it("does not stay on 'Rewind chat to here…' when the rewind never settles", async () => {
    vi.useFakeTimers();
    const onRewindChat = vi.fn(() => new Promise<void>(() => undefined));
    await openConfirm(rewind(onRewindChat));
    await act(async () => confirmButton()!.click());
    expect(text()).toContain("Rewind chat to here…");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MENU_CHAT_REWIND_LIMIT_MS - 1);
    });
    expect(text()).toContain("Rewind chat to here…");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(text()).not.toContain("Rewind chat to here…");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "did not answer the rewind in time",
    );
  });

  it("starts one rewind for a double press on the confirm button", async () => {
    const onRewindChat = vi.fn(() => new Promise<void>(() => undefined));
    await openConfirm(rewind(onRewindChat));
    const button = confirmButton()!;
    // Both clicks land before React renders the "working" stage.
    await act(async () => {
      button.click();
      button.click();
    });
    expect(onRewindChat).toHaveBeenCalledTimes(1);
  });

  it("shows the host's refusal of a second rewind as an error", async () => {
    const onRewindChat = vi.fn(async () => {
      throw new Error("A rewind of this chat is still running. Wait for it to finish");
    });
    await openConfirm(rewind(onRewindChat));
    await act(async () => confirmButton()!.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "still running",
    );
  });
});
