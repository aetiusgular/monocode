import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mac test 2.8: a reload drops every Tauri listener and wipes this module's
 * state, while the child keeps printing. These tests reload the module and
 * feed the replay Rust kept.
 */
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (
    name: string,
    handler: (event: { payload: unknown }) => void,
  ) => {
    mocks.handlers.set(name, handler);
    return () => undefined;
  },
}));

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

function stdout(sessionId: string, seq: number, lines: string[]) {
  mocks.handlers.get("harness-stdout")!({
    payload: { sessionId, lines, seq },
  });
}

async function loadChild() {
  vi.resetModules();
  mocks.handlers.clear();
  return import("./child");
}

/** The first page: spawns the child, sees two lines, then unloads. */
async function firstPage() {
  const child = await loadChild();
  child.startHarnessBridge();
  await child.acquireHarnessBridge();
  mocks.invoke.mockImplementation(async (command: string) =>
    command === "harness_spawn" ? 42 : undefined,
  );
  const seen: string[] = [];
  child.watchChild(
    "chat",
    (line) => seen.push(line),
    () => undefined,
  );
  await child.spawnChild("chat", "/bin/claude", [], "/repo");
  stdout("chat", 1, ["a", "b"]);
  child.saveChildrenForReload(["chat"]);
  return seen;
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", memoryStorage());
  mocks.invoke.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a child that outlives a page reload", () => {
  it("hands the next watcher every missed line once, in order, then live ones", async () => {
    expect(await firstPage()).toEqual(["a", "b"]);
    // Printed while the page reloaded: only Rust has these.
    const child = await loadChild();
    mocks.invoke.mockImplementation(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === "harness_live_sessions")
          return [{ sessionId: "chat", pid: 42, lastSeq: 5, exited: false }];
        if (command === "harness_replay") {
          expect(args).toEqual({ sessionId: "chat", afterSeq: 2 });
          // A live batch lands while the replay is read; it overlaps.
          stdout("chat", 5, ["e", "f"]);
          return {
            entries: [
              { seq: 3, line: "c" },
              { seq: 4, line: "d" },
              { seq: 5, line: "e" },
            ],
            exit: null,
            firstSeq: 1,
            lastSeq: 5,
            truncated: false,
          };
        }
        return undefined;
      },
    );
    child.startHarnessBridge();
    expect(await child.reattachChild("chat")).toBe(true);
    const seen: string[] = [];
    child.watchChild(
      "chat",
      (line) => seen.push(line),
      () => undefined,
    );
    stdout("chat", 6, ["f", "g"]);
    expect(seen).toEqual(["c", "d", "e", "f", "g"]);
  });

  it("delivers the exit the replay holds after its lines", async () => {
    await firstPage();
    const child = await loadChild();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "harness_live_sessions")
        return [{ sessionId: "chat", pid: 42, lastSeq: 4, exited: true }];
      if (command === "harness_replay")
        return {
          entries: [{ seq: 3, line: "c" }],
          exit: { code: 0, pid: 42, seq: 4 },
          firstSeq: 1,
          lastSeq: 4,
          truncated: false,
        };
      return undefined;
    });
    child.startHarnessBridge();
    expect(await child.reattachChild("chat")).toBe(true);
    const order: string[] = [];
    child.watchChild(
      "chat",
      (line) => order.push(line),
      (code) => order.push(`exit ${code}`),
    );
    mocks.handlers.get("harness-exit")!({
      payload: { sessionId: "chat", code: 0, pid: 42, seq: 4 },
    });
    expect(order).toEqual(["c", "exit 0"]);
  });

  it("does not take back a child replaced by another pid, or one Rust lost lines of", async () => {
    await firstPage();
    let child = await loadChild();
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "harness_live_sessions"
        ? [{ sessionId: "chat", pid: 99, lastSeq: 9, exited: false }]
        : undefined,
    );
    child.startHarnessBridge();
    expect(await child.reattachChild("chat")).toBe(false);

    await firstPage();
    child = await loadChild();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "harness_live_sessions")
        return [{ sessionId: "chat", pid: 42, lastSeq: 9000, exited: false }];
      return {
        entries: [],
        exit: null,
        firstSeq: 5000,
        lastSeq: 9000,
        truncated: true,
      };
    });
    child.startHarnessBridge();
    expect(await child.reattachChild("chat")).toBe(false);
  });

  it("keeps the handed-over children when the old page kills the rest", async () => {
    await firstPage();
    const { killAllChildren } = await import("./child");
    mocks.invoke.mockResolvedValue(undefined);
    await killAllChildren(["chat"]);
    expect(mocks.invoke).toHaveBeenCalledWith("harness_kill_all", {
      keep: ["chat"],
    });
  });
});

describe("the reload note", () => {
  it("counts from before lines that were buffered but never handed on", async () => {
    const child = await loadChild();
    child.startHarnessBridge();
    await child.acquireHarnessBridge();
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "harness_spawn" ? 42 : undefined,
    );
    await child.spawnChild("chat", "/bin/claude", [], "/repo");
    stdout("chat", 7, ["x", "y"]);
    child.saveChildrenForReload(["chat"]);
    expect(
      JSON.parse(sessionStorage.getItem("monocode.harnessReloadChildren")!),
    ).toEqual([{ sessionId: "chat", pid: 42, lastSeq: 6 }]);
  });
});
