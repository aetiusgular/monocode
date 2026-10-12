// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { TurnRewindMenu } = await import("./TurnRewindMenu");
import type { RewindOptions } from "../model/rewind";
import type { TurnRewind } from "../model/turnRewind";

let container: HTMLDivElement;
let root: Root;

const options = (patch: Partial<RewindOptions> = {}): RewindOptions => ({
  blockId: "u1",
  turnStart: 0,
  turnEnd: 2,
  isLastTurn: false,
  laterPrompts: 2,
  chat: { enabled: true, providerTurnId: "p1" },
  files: { enabled: true, checkpointTurnId: "cp1" },
  fork: { enabled: true, plan: { mode: "native", harness: "codex", lastTurnId: "p1" } },
  ...patch,
});

function rewind(patch: Partial<TurnRewind> = {}, opts = options()): TurnRewind {
  return {
    sessionId: "s1",
    cwd: "/repo",
    optionsFor: () => opts,
    onRewindChat: vi.fn(async () => undefined),
    onFork: vi.fn(async () => undefined),
    ...patch,
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
  vi.unstubAllGlobals();
});

async function open(props: TurnRewind) {
  await act(async () => {
    root.render(createElement(TurnRewindMenu, { rewind: props, blockId: "u1" }));
  });
  await act(async () =>
    container.querySelector<HTMLButtonElement>("[data-turn-rewind]")!.click(),
  );
}

const item = (action: string) =>
  document.querySelector<HTMLButtonElement>(`[data-rewind-action="${action}"]`)!;
const text = () => document.querySelector("[data-turn-rewind-menu]")?.textContent ?? "";

describe("TurnRewindMenu", () => {
  it("offers the three actions, off with their reasons when they cannot run", async () => {
    await open(
      rewind(
        {},
        options({
          chat: { enabled: false, reason: "This harness cannot take back its conversation" },
          fork: {
            enabled: true,
            plan: { mode: "approximate", reason: "This harness cannot copy its own conversation" },
          },
        }),
      ),
    );
    expect(item("chat").disabled).toBe(true);
    expect(text()).toContain("cannot take back its conversation");
    expect(item("files").disabled).toBe(false);
    expect(text()).toContain("approximate");
  });

  it("asks before a chat rewind, then rewinds", async () => {
    const props = rewind();
    await open(props);
    await act(async () => item("chat").click());
    expect(text()).toContain("the 2 prompts after it");
    expect(props.onRewindChat).not.toHaveBeenCalled();
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-rewind-confirm]")!.click(),
    );
    expect(props.onRewindChat).toHaveBeenCalledWith("u1");
    expect(document.querySelector("[data-turn-rewind-menu]")).toBeNull();
  });

  it("shows a refused rewind's reason and keeps the menu open", async () => {
    const props = rewind({
      onRewindChat: vi.fn(async () => {
        throw new Error("Claude Code could not go back to before this message");
      }),
    });
    await open(props);
    await act(async () => item("chat").click());
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-rewind-confirm]")!.click(),
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "could not go back",
    );
  });

  it("previews the files, then restores them with the turn's checkpoint", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "session_checkpoint_restore_preview") {
        return {
          turnId: "cp1",
          blocked: null,
          files: [
            { path: "/repo/a.txt", relative: "a.txt", action: "restore", restorable: true },
            { path: "/repo/new.txt", relative: "new.txt", action: "delete", restorable: true },
            {
              path: "/repo/link",
              relative: "link",
              action: "delete",
              restorable: false,
              reason: "It sits behind a symbolic link",
            },
          ],
        };
      }
      if (command === "session_checkpoint_restore_turn") {
        return {
          restored: ["a.txt", "new.txt"],
          skipped: ["link"],
          backup: "0123456789abcdef",
          backupRef: "refs/monocode/checkpoints/s1/restore-x/backup",
        };
      }
      throw new Error(`unexpected ${command}`);
    });
    await open(rewind());
    await act(async () => item("files").click());
    expect(invoke).toHaveBeenCalledWith("session_checkpoint_restore_preview", {
      sessionId: "s1",
      cwd: "/repo",
      turnId: "cp1",
    });
    expect(text()).toContain("This changes 2 files");
    const confirm = document.querySelector<HTMLButtonElement>("[data-restore-confirm]")!;
    expect(confirm.textContent).toBe("Restore 2 files");
    await act(async () => confirm.click());
    expect(invoke).toHaveBeenCalledWith("session_checkpoint_restore_turn", {
      sessionId: "s1",
      cwd: "/repo",
      turnId: "cp1",
    });
    expect(text()).toContain("Restored 2 files. Left 1 as they were.");
    expect(text()).toContain("0123456789");
  });

  it("will not restore when the folder is blocked", async () => {
    invoke.mockResolvedValue({
      turnId: "cp1",
      blocked: "The branch has moved since this turn. Commits are never undone here",
      files: [{ path: "/repo/a.txt", relative: "a.txt", action: "restore", restorable: true }],
    });
    await open(rewind());
    await act(async () => item("files").click());
    expect(text()).toContain("branch has moved");
    expect(
      document.querySelector<HTMLButtonElement>("[data-restore-confirm]")!.disabled,
    ).toBe(true);
  });

  it("forks", async () => {
    const props = rewind();
    await open(props);
    await act(async () => item("fork").click());
    expect(props.onFork).toHaveBeenCalledWith("u1");
  });
});
