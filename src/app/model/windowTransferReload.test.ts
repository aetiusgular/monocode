import { beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, type Session } from "../../features/sessions/model/session";
import { newTab, type WorkspaceTab } from "../../features/workspace/model/layout";
import { collectWorkspaceSnapshot } from "../../features/workspace/model/workspaceSnapshot";
import { collectWindowTransfer } from "./windowTransfer";

// Mac 4.14: View, Reload in a moved window loaded the main workspace into it.
// The window took its tabs once at boot, so a reload found nothing and booted
// like the main window. These tests run each "window" as a fresh module load
// against one fake app: Rust's held tabs by label, and the session store.

type Held = { kind: "transfer" | "tabs"; json: string };

const app = vi.hoisted(() => ({
  label: "main",
  held: new Map<string, Held>(),
  mainSnapshot: null as unknown,
  store: new Map<string, unknown>(),
  inFlight: [] as { sessionId: string; cwd: string }[],
  calls: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    app.calls.push(command);
    const moved = app.label.startsWith("moved-");
    switch (command) {
      case "load_window_tabs":
        return moved ? (app.held.get(app.label) ?? null) : null;
      case "hold_window_tabs":
        if (!moved) throw new Error("only a moved window holds its own tabs");
        app.held.set(app.label, { kind: "tabs", json: String(args?.tabs) });
        return undefined;
      case "workspace_set_snapshot":
        app.mainSnapshot = structuredClone(args?.snapshot);
        return undefined;
      case "session_set_in_flight":
        app.inFlight = structuredClone(
          args?.sessions as { sessionId: string; cwd: string }[],
        );
        return undefined;
      default:
        return undefined;
    }
  }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: app.label }),
}));
vi.mock("../../features/sessions/data/sessionStore", async (original) => ({
  ...(await original<
    typeof import("../../features/sessions/data/sessionStore")
  >()),
  loadWorkspaceSnapshot: vi.fn(async () => {
    app.calls.push("loadWorkspaceSnapshot");
    return structuredClone(app.mainSnapshot);
  }),
  listInFlightSessions: vi.fn(async () => app.inFlight),
  listSessionsByProject: vi.fn(async () => []),
  getSession: vi.fn(async (id: string) =>
    app.store.has(id) ? structuredClone(app.store.get(id)) : null,
  ),
  upsertSession: vi.fn(async (session: Session) => {
    app.store.set(session.id, structuredClone(session));
    return null;
  }),
}));
vi.mock("../../integrations/harness/core/registry", () => ({}));
vi.mock("../../integrations/harness/core/child", () => ({}));

const CWD = "/Users/me/repo";

function chat(id: string, text: string): Session {
  return {
    ...newSession("claude", CWD),
    id,
    title: text,
    providerSessionId: `conv-${id}`,
    blocks: [{ id: `user-${id}`, role: "user", text }],
  };
}

function tabFor(id: string, session: Session): WorkspaceTab {
  return { ...newTab(session.id), id };
}

/** The main window's workspace as the store holds it. */
function mainWorkspace() {
  const sessions = [chat("main-1", "Main chat one"), chat("main-2", "Main chat two")];
  const tabs = sessions.map((session) => tabFor(`tab-${session.id}`, session));
  for (const session of sessions) app.store.set(session.id, session);
  app.mainSnapshot = collectWorkspaceSnapshot(
    tabs,
    sessions,
    tabs[0].id,
    CWD,
    new Map(),
  );
  return { sessions, tabs };
}

/**
 * Move to New Window as the source window and Rust do it: the source has the
 * chat in the store, and Rust holds the staged payload for the new label.
 */
function moveTo(label: string, session: Session) {
  const keep = tabFor("tab-keep", chat("keep", "Stays"));
  const moving = tabFor(`tab-${session.id}`, session);
  const payload = collectWindowTransfer(
    [keep, moving],
    [session],
    [moving.id],
    moving.id,
    new Set(),
    CWD,
  )!;
  app.store.set(session.id, session);
  app.held.set(label, { kind: "transfer", json: JSON.stringify(payload) });
  return moving;
}

/** A webview boot: fresh modules, so nothing survives but the fake app. */
async function boot(label: string) {
  app.label = label;
  vi.resetModules();
  const lifecycle = await import("./appLifecycle");
  const workspace = await lifecycle.loadBootWorkspace();
  return { lifecycle, workspace };
}

/** What a window writes when its page unloads, as App's reap does. */
async function unload(
  lifecycle: typeof import("./appLifecycle"),
  sessions: Session[],
  tabs: WorkspaceTab[],
  activeTabId: string,
) {
  await lifecycle.persistQuitState(
    sessions,
    tabs,
    activeTabId,
    CWD,
    new Map(),
    "unload",
  );
}

const tabIds = (tabs: WorkspaceTab[] | undefined) =>
  (tabs ?? []).map((tab) => tab.id);

beforeEach(() => {
  app.label = "main";
  app.held.clear();
  app.store.clear();
  app.inFlight = [];
  app.mainSnapshot = null;
  app.calls.length = 0;
});

describe("reloading a moved window", () => {
  it("keeps the tab it held, with its transcript, and not the main workspace", async () => {
    mainWorkspace();
    const moved = moveTo("moved-2", chat("moved-1", "Remember HERON42"));

    const first = await boot("moved-2");
    expect(first.workspace.resumed).toBeNull();
    expect(tabIds(first.workspace.windowTransfer?.tabs)).toEqual([moved.id]);

    // The chat goes on in the moved window, then the page unloads.
    const live = first.workspace.windowTransfer!;
    const sessions = live.sessions.map((session) => ({
      ...session,
      blocks: [
        ...session.blocks,
        { id: "reply", role: "assistant" as const, text: "OK" },
      ],
    }));
    await unload(first.lifecycle, sessions, live.tabs, live.activeTabId);

    const reloaded = await boot("moved-2");
    const transfer = reloaded.workspace.windowTransfer;
    expect(reloaded.workspace.resumed).toBeNull();
    expect(tabIds(transfer?.tabs)).toEqual([moved.id]);
    expect(transfer?.activeTabId).toBe(moved.id);
    expect(transfer?.sessions.map((session) => session.id)).toEqual(["moved-1"]);
    expect(transfer?.sessions[0].blocks.map((block) => block.text)).toEqual([
      "Remember HERON42",
      "OK",
    ]);
    // Bound again at boot, so the chat resumes its own conversation.
    expect(transfer?.sessions[0].providerSessionId).toBe("conv-moved-1");
    expect(app.calls).not.toContain("loadWorkspaceSnapshot");
  });

  it("keeps the tab when the page reloads before it held anything", async () => {
    mainWorkspace();
    const moved = moveTo("moved-2", chat("moved-1", "Moved"));
    await boot("moved-2");
    const reloaded = await boot("moved-2");
    expect(tabIds(reloaded.workspace.windowTransfer?.tabs)).toEqual([moved.id]);
  });

  it("marks a turn the reload cut off as interrupted", async () => {
    mainWorkspace();
    const moved = moveTo("moved-2", chat("moved-1", "Long task"));
    const first = await boot("moved-2");
    const live = first.workspace.windowTransfer!;
    const running = live.sessions.map((session) => ({ ...session, busy: true }));
    await unload(first.lifecycle, running, live.tabs, live.activeTabId);

    const reloaded = await boot("moved-2");
    const session = reloaded.workspace.windowTransfer?.sessions[0];
    expect(tabIds(reloaded.workspace.windowTransfer?.tabs)).toEqual([moved.id]);
    expect(session?.busy).toBe(false);
    expect(session?.blocks.at(-1)?.notice).toBe("interrupt");
  });

  it("does not take another window's running chat into its tabs", async () => {
    mainWorkspace();
    const moved = moveTo("moved-2", chat("moved-1", "Moved"));
    const first = await boot("moved-2");
    const live = first.workspace.windowTransfer!;
    await unload(first.lifecycle, live.sessions, live.tabs, live.activeTabId);
    // A turn running in the main window is listed in flight.
    app.inFlight = [{ sessionId: "main-1", cwd: CWD }];
    const reloaded = await boot("moved-2");
    expect(tabIds(reloaded.workspace.windowTransfer?.tabs)).toEqual([moved.id]);
    expect(
      reloaded.workspace.windowTransfer?.sessions.map((session) => session.id),
    ).toEqual(["moved-1"]);
  });
});

describe("the main workspace snapshot", () => {
  it("is not changed by a moved window's unload, close or quit", async () => {
    const main = mainWorkspace();
    const before = structuredClone(app.mainSnapshot);
    moveTo("moved-2", chat("moved-1", "Moved"));

    const { lifecycle, workspace } = await boot("moved-2");
    const live = workspace.windowTransfer!;
    await unload(lifecycle, live.sessions, live.tabs, live.activeTabId);
    await lifecycle.persistQuitState(
      live.sessions,
      live.tabs,
      live.activeTabId,
      CWD,
      new Map(),
      "quit",
    );
    expect(app.calls).not.toContain("workspace_set_snapshot");
    expect(app.mainSnapshot).toEqual(before);
    // The moved chat is still saved, so it stays in History.
    expect(app.store.has("moved-1")).toBe(true);
    expect(tabIds(main.tabs)).toEqual(["tab-main-1", "tab-main-2"]);
  });

  it("is not reopened with the moved tabs after a quit", async () => {
    mainWorkspace();
    moveTo("moved-2", chat("moved-1", "Moved"));
    const { lifecycle, workspace } = await boot("moved-2");
    const live = workspace.windowTransfer!;
    const release = lifecycle.setQuitWorkspace(
      () => live.sessions,
      () => live.tabs,
      () => live.activeTabId,
      () => live.projectCwd,
      () => [],
      () => new Map(),
      vi.fn(),
    );
    try {
      expect(await lifecycle.handleQuitRequested()).toBe(true);
    } finally {
      release();
    }
    // A relaunch: Rust's memory is gone and only the main window opens.
    app.held.clear();
    const relaunched = await boot("main");
    expect(tabIds(relaunched.workspace.resumed?.tabs)).toEqual([
      "tab-main-1",
      "tab-main-2",
    ]);
  });
});

describe("the list of running chats", () => {
  it("never gets a moved window's chat, so the main window does not reopen it", async () => {
    mainWorkspace();
    app.inFlight = [];
    moveTo("moved-2", chat("moved-1", "Long task"));
    const { lifecycle, workspace } = await boot("moved-2");
    const live = workspace.windowTransfer!;
    const running = live.sessions.map((session) => ({ ...session, busy: true }));
    await unload(lifecycle, running, live.tabs, live.activeTabId);
    await lifecycle.persistQuitState(
      running,
      live.tabs,
      live.activeTabId,
      CWD,
      new Map(),
      "quit",
    );
    expect(app.calls).not.toContain("session_set_in_flight");

    const main = await boot("main");
    expect(tabIds(main.workspace.resumed?.tabs)).toEqual([
      "tab-main-1",
      "tab-main-2",
    ]);
  });

  it("still gets the main window's running chats", async () => {
    const main = mainWorkspace();
    const { lifecycle } = await boot("main");
    const running = main.sessions.map((session, index) =>
      index === 0 ? { ...session, busy: true } : session,
    );
    await lifecycle.persistQuitState(
      running,
      main.tabs,
      main.tabs[0].id,
      CWD,
      new Map(),
      "quit",
    );
    expect(app.inFlight.map((ref) => ref.sessionId)).toEqual(["main-1"]);
  });
});

describe("reloading the main window", () => {
  it("still restores the main workspace, and never a moved window's tabs", async () => {
    mainWorkspace();
    moveTo("moved-2", chat("moved-1", "Moved"));
    const { workspace } = await boot("main");
    expect(workspace.windowTransfer).toBeNull();
    expect(tabIds(workspace.resumed?.tabs)).toEqual(["tab-main-1", "tab-main-2"]);
    expect(app.calls).toContain("loadWorkspaceSnapshot");
    expect(app.calls).not.toContain("load_window_tabs");
  });

  it("still saves the main workspace on unload", async () => {
    const main = mainWorkspace();
    const { lifecycle } = await boot("main");
    const tabs = main.tabs.slice(1);
    await unload(lifecycle, main.sessions, tabs, tabs[0].id);
    expect(app.calls).toContain("workspace_set_snapshot");
    expect(app.calls).not.toContain("hold_window_tabs");
    const relaunched = await boot("main");
    expect(tabIds(relaunched.workspace.resumed?.tabs)).toEqual(["tab-main-2"]);
  });
});

describe("a moved window whose tabs are not held", () => {
  it("opens one blank chat, not the main workspace", async () => {
    mainWorkspace();
    const { lifecycle, workspace } = await boot("moved-9");
    const transfer = workspace.windowTransfer;
    expect(workspace.resumed).toBeNull();
    expect(transfer?.tabs).toHaveLength(1);
    expect(transfer?.sessions).toHaveLength(1);
    expect(transfer?.sessions[0].blocks).toEqual([]);
    expect(transfer?.activeTabId).toBe(transfer?.tabs[0].id);
    expect(tabIds(transfer?.tabs)).not.toContain("tab-main-1");
    expect(app.calls).not.toContain("loadWorkspaceSnapshot");

    // Nor does it write the main workspace afterwards.
    const before = structuredClone(app.mainSnapshot);
    await unload(
      lifecycle,
      transfer!.sessions,
      transfer!.tabs,
      transfer!.activeTabId,
    );
    expect(app.mainSnapshot).toEqual(before);
  });

  it("opens a blank chat when what it holds cannot be read", async () => {
    mainWorkspace();
    app.held.set("moved-4", { kind: "tabs", json: "{not json" });
    const { workspace } = await boot("moved-4");
    expect(workspace.windowTransfer?.tabs).toHaveLength(1);
    expect(tabIds(workspace.windowTransfer?.tabs)).not.toContain("tab-main-1");
  });
});

describe("two moved windows", () => {
  it("each keep their own tab through a reload", async () => {
    mainWorkspace();
    const a = moveTo("moved-2", chat("moved-a", "First"));
    const b = moveTo("moved-3", chat("moved-b", "Second"));

    for (const label of ["moved-2", "moved-3"]) {
      const { lifecycle, workspace } = await boot(label);
      const live = workspace.windowTransfer!;
      await unload(lifecycle, live.sessions, live.tabs, live.activeTabId);
    }

    const second = await boot("moved-3");
    const first = await boot("moved-2");
    expect(tabIds(first.workspace.windowTransfer?.tabs)).toEqual([a.id]);
    expect(tabIds(second.workspace.windowTransfer?.tabs)).toEqual([b.id]);
    expect(first.workspace.windowTransfer?.sessions[0].title).toBe("First");
    expect(second.workspace.windowTransfer?.sessions[0].title).toBe("Second");
  });
});

describe("holding a moved window's tabs", () => {
  it("sends the snapshot as text for Rust to keep", async () => {
    app.label = "moved-2";
    vi.resetModules();
    const { holdWindowTabs } = await import("./windowTransferBootstrap");
    const session = chat("moved-1", "Moved");
    const snapshot = collectWorkspaceSnapshot(
      [tabFor("tab-1", session)],
      [session],
      "tab-1",
      CWD,
      new Map(),
    );
    await holdWindowTabs(snapshot);
    const held = app.held.get("moved-2");
    expect(held?.kind).toBe("tabs");
    expect(JSON.parse(held!.json)).toEqual(snapshot);
  });
});
