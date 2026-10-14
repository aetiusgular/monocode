import { describe, expect, it, vi } from "vitest";
import type { WorkspaceTab } from "../../features/workspace/model/layout";
import type { Session } from "../../features/sessions/model/session";
import { collectWindowTransfer, popOutTabs } from "./windowTransfer";

// Security review W4: when the new window failed to open after the payload
// was staged, the payload stayed for 60 s while the tabs stayed here, and a
// New Window opened in that time took it. Two windows then drove the same
// provider conversations.

const tab = (id: string, sessionId: string): WorkspaceTab =>
  ({
    kind: "session",
    id,
    layout: { type: "leaf", id: sessionId },
    focusedId: sessionId,
    editorPanes: [],
    terminalPanes: [],
  }) as unknown as WorkspaceTab;

const session = (id: string): Session =>
  ({
    id,
    harness: "claude",
    model: "",
    modelSettings: {},
    runtimeMode: "supervised",
    title: id,
    cwd: "/Users/me/repo",
    blocks: [],
    providerSessionId: `conv-${id}`,
  }) as unknown as Session;

/** The Rust slot: one payload, taken once, cleared on request. */
function fakeSlot() {
  let slot: string | null = null;
  return {
    stage: vi.fn(async (json: string) => {
      slot = json;
    }),
    clear: vi.fn(async () => {
      slot = null;
    }),
    /** What a New Window takes as it boots. */
    take: () => {
      const taken = slot;
      slot = null;
      return taken;
    },
  };
}

const payload = () =>
  collectWindowTransfer(
    [tab("t1", "s1"), tab("t2", "s2")],
    [session("s1"), session("s2")],
    ["t2"],
    "t1",
    new Set(),
    "/Users/me/repo",
  )!;

describe("popOutTabs clears the payload when the window does not open", () => {
  it("a later New Window takes nothing, and the tab stays", async () => {
    const slot = fakeSlot();
    const closeTabs = vi.fn();
    const result = await popOutTabs({
      payload: payload(),
      stopSession: async () => undefined,
      stage: slot.stage,
      openWindow: async () => {
        throw new Error("window failed");
      },
      unstage: slot.clear,
      closeTabs,
    });
    expect(result.ok).toBe(false);
    expect(slot.stage).toHaveBeenCalledTimes(1);
    expect(slot.clear).toHaveBeenCalledTimes(1);
    expect(closeTabs).not.toHaveBeenCalled();
    expect(slot.take()).toBeNull();
  });

  it("clears after a stage that failed partway", async () => {
    const slot = fakeSlot();
    const result = await popOutTabs({
      payload: payload(),
      stopSession: async () => undefined,
      stage: async (json) => {
        await slot.stage(json);
        throw new Error("ipc dropped the reply");
      },
      openWindow: async () => undefined,
      unstage: slot.clear,
      closeTabs: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(slot.take()).toBeNull();
  });

  it("reports the open failure even when clearing fails too", async () => {
    const result = await popOutTabs({
      payload: payload(),
      stopSession: async () => undefined,
      stage: async () => undefined,
      openWindow: async () => {
        throw new Error("window failed");
      },
      unstage: async () => {
        throw new Error("no state");
      },
      closeTabs: () => undefined,
    });
    expect(result).toEqual({
      ok: false,
      reason: "Could not open a new window: window failed",
    });
  });

  it("leaves the payload for the window that opened", async () => {
    const slot = fakeSlot();
    const closeTabs = vi.fn();
    const result = await popOutTabs({
      payload: payload(),
      stopSession: async () => undefined,
      stage: slot.stage,
      openWindow: async () => undefined,
      unstage: slot.clear,
      closeTabs,
    });
    expect(result.ok).toBe(true);
    expect(slot.clear).not.toHaveBeenCalled();
    expect(closeTabs).toHaveBeenCalledWith(["t2"]);
    const taken = JSON.parse(slot.take()!);
    expect(taken.sessions.map((s: Session) => s.providerSessionId)).toEqual([
      "conv-s2",
    ]);
  });
});
