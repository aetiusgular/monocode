import { describe, expect, it, vi } from "vitest";
import type { WorkspaceTab } from "../../features/workspace/model/layout";
import type { Session } from "../../features/sessions/model/session";
import {
  collectWindowTransfer,
  popOutCheck,
  popOutTabs,
  sessionNotIdle,
} from "./windowTransfer";

const tab = (
  id: string,
  sessionIds: string[],
  files: { id: string; terminal?: boolean }[] = [],
): WorkspaceTab =>
  ({
    kind: "session",
    id,
    layout:
      sessionIds.length === 1
        ? { type: "leaf", id: sessionIds[0] }
        : {
            type: "split",
            id: `${id}-split`,
            direction: "row",
            sizes: sessionIds.map(() => 1),
            children: sessionIds.map((sid) => ({ type: "leaf", id: sid })),
          },
    focusedId: sessionIds[0],
    editorPanes: files.length ? [{ id: `${id}-p`, files }] : [],
    terminalPanes: [],
  }) as unknown as WorkspaceTab;

const session = (id: string, over: Partial<Session> = {}): Session =>
  ({
    id,
    harness: "codex",
    model: "",
    modelSettings: {},
    runtimeMode: "supervised",
    title: id,
    cwd: "/Users/me/my repo",
    blocks: [],
    ...over,
  }) as unknown as Session;

const TABS = [tab("t1", ["s1"]), tab("t2", ["s2", "s3"])];
const SESSIONS = [session("s1"), session("s2"), session("s3")];

describe("which tabs can move to a new window", () => {
  it("moves a tab of idle chats, split panes included", () => {
    expect(popOutCheck(TABS, SESSIONS, "t2", new Set())).toEqual({ ok: true });
  });

  it("keeps the last tab", () => {
    expect(popOutCheck([TABS[0]], SESSIONS, "t1", new Set())).toEqual({
      ok: false,
      reason: "A window keeps at least one tab.",
    });
  });

  it("refuses while any chat in the tab is not idle, saying why (case 16)", () => {
    const cases: [Partial<Session>, string][] = [
      [{ busy: true }, "a turn is running"],
      [{ resendingEdited: true }, "a turn is running"],
      [{ sendingQueuedMessageId: "q" }, "a turn is running"],
      [
        { queuedMessages: [{ id: "q" }] as Session["queuedMessages"] },
        "messages are queued",
      ],
      [{ backgroundTasks: ["npm run dev"] }, "background work is running"],
      [
        { pendingSwitch: {} as Session["pendingSwitch"] },
        "a harness switch is pending",
      ],
      [{ worktreePreparing: true }, "its worktree is being made"],
      [
        { pendingQuestion: {} as Session["pendingQuestion"] },
        "it is waiting for your answer",
      ],
      [
        {
          blocks: [
            { id: "b", role: "tool", text: "", approval: { requestId: 1 } },
          ] as Session["blocks"],
        },
        "it is waiting for an approval",
      ],
    ];
    for (const [over, why] of cases) {
      const sessions = [session("s1"), session("s2"), session("s3", over)];
      const check = popOutCheck(TABS, sessions, "t2", new Set());
      expect(check).toEqual({
        ok: false,
        reason: `Wait until the chat is idle: ${why}.`,
      });
    }
  });

  it("lets a decided approval through", () => {
    const decided = session("s1", {
      blocks: [
        {
          id: "b",
          role: "tool",
          text: "",
          approval: { requestId: 1, decided: "allow" },
        },
      ] as Session["blocks"],
    });
    expect(sessionNotIdle(decided)).toBeNull();
  });

  it("keeps tabs with terminals, unsaved files, orchestration or remote chats", () => {
    const withTerminal = [
      tab("t1", ["s1"]),
      tab("t2", ["s2"], [{ id: "term", terminal: true }]),
    ];
    expect(popOutCheck(withTerminal, SESSIONS, "t2", new Set())).toMatchObject({
      ok: false,
      reason: expect.stringContaining("terminals"),
    });
    const withFile = [tab("t1", ["s1"]), tab("t2", ["s2"], [{ id: "f1" }])];
    expect(popOutCheck(withFile, SESSIONS, "t2", new Set(["f1"]))).toEqual({
      ok: false,
      reason: "Save its files first.",
    });
    expect(popOutCheck(withFile, SESSIONS, "t2", new Set())).toEqual({
      ok: true,
    });
    expect(
      popOutCheck(
        TABS,
        [session("s1", { orchestrationLeadId: "lead" })],
        "t1",
        new Set(),
      ),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Orchestration"),
    });
    expect(
      popOutCheck(
        TABS,
        [session("s1", { cwd: "ssh://box/repo" })],
        "t1",
        new Set(),
        (cwd) => cwd.startsWith("ssh://"),
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("Remote") });
  });

  it("refuses a tab that is gone", () => {
    expect(popOutCheck(TABS, SESSIONS, "nope", new Set()).ok).toBe(false);
  });
});

describe("moving a tab", () => {
  const payload = () =>
    collectWindowTransfer(TABS, SESSIONS, ["t2"], "t1", new Set(), "/repo")!;

  it("stops each chat, stages the payload, opens the window, then closes the tab here", async () => {
    const order: string[] = [];
    const result = await popOutTabs({
      payload: payload(),
      stopSession: async (s) => void order.push(`stop ${s.id}`),
      stage: async (json) => {
        order.push("stage");
        const parsed = JSON.parse(json);
        expect(parsed.tabs.map((t: { id: string }) => t.id)).toEqual(["t2"]);
        expect(parsed.sessions.map((s: { id: string }) => s.id)).toEqual([
          "s2",
          "s3",
        ]);
        expect(parsed.activeTabId).toBe("t2");
      },
      openWindow: async () => void order.push("open"),
      closeTabs: (ids) => order.push(`close ${ids.join(",")}`),
    });
    expect(result).toEqual({ ok: true });
    expect(order).toEqual(["stop s2", "stop s3", "stage", "open", "close t2"]);
  });

  it("keeps the tab here when the window does not open", async () => {
    const closeTabs = vi.fn();
    const result = await popOutTabs({
      payload: payload(),
      stopSession: async () => undefined,
      stage: async () => undefined,
      openWindow: async () => {
        throw new Error("missing main window config");
      },
      closeTabs,
    });
    expect(result).toEqual({
      ok: false,
      reason: "Could not open a new window: missing main window config",
    });
    expect(closeTabs).not.toHaveBeenCalled();
  });

  it("goes on when a chat's process is already gone", async () => {
    const closeTabs = vi.fn();
    const result = await popOutTabs({
      payload: payload(),
      stopSession: async () => {
        throw new Error("no such session");
      },
      stage: async () => undefined,
      openWindow: async () => undefined,
      closeTabs,
    });
    expect(result.ok).toBe(true);
    expect(closeTabs).toHaveBeenCalledWith(["t2"]);
  });
});
