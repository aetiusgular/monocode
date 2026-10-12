import { describe, expect, it, vi } from "vitest";
import {
  codexTerminalItem,
  isMissingMethodError,
  listCodexBackgroundTerminals,
  terminateCodexBackgroundTerminal,
  type CodexRequester,
} from "./codexBackground";

function fakeRpc(
  handler: (method: string, params: Record<string, unknown>) => unknown,
): CodexRequester & { calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    calls,
    async request<T>(method: string, params?: unknown): Promise<T> {
      const record = (params ?? {}) as Record<string, unknown>;
      calls.push([method, record]);
      const result = handler(method, record);
      if (result instanceof Error) throw result;
      return result as T;
    },
  };
}

const terminal = (processId: string, command: string) => ({
  itemId: `item_${processId}`,
  processId,
  command,
  cwd: "/repo",
  osPid: 4242,
  cpuPercent: null,
  rssKb: null,
});

describe("codexTerminalItem", () => {
  it("maps a terminal to a stoppable shell row", () => {
    expect(codexTerminalItem(terminal("42", "npm run dev"))).toEqual({
      id: "42",
      kind: "shell",
      title: "npm run dev",
      status: "running",
      stoppable: true,
      source: "harness",
    });
  });

  it("drops a row with no process id and names an empty command", () => {
    expect(codexTerminalItem({ command: "x" })).toBeNull();
    expect(codexTerminalItem(null)).toBeNull();
    expect(codexTerminalItem({ processId: "7", command: "" })?.title).toBe(
      "Process 7",
    );
  });
});

describe("listCodexBackgroundTerminals", () => {
  it("sends the wire shape Codex 0.161.0 expects", async () => {
    const rpc = fakeRpc(() => ({ data: [terminal("1", "sleep 9")], nextCursor: null }));
    const items = await listCodexBackgroundTerminals(rpc, "thr_1");
    expect(items?.map((item) => item.id)).toEqual(["1"]);
    expect(rpc.calls).toEqual([
      [
        "thread/backgroundTerminals/list",
        { threadId: "thr_1", cursor: null, limit: 50 },
      ],
    ]);
  });

  it("follows the cursor and stops after a few pages", async () => {
    let page = 0;
    const rpc = fakeRpc(() => {
      page += 1;
      return { data: [terminal(String(page), `cmd ${page}`)], nextCursor: `c${page}` };
    });
    const items = await listCodexBackgroundTerminals(rpc, "thr_1");
    expect(items).toHaveLength(4);
    expect(rpc.calls[1][1].cursor).toBe("c1");
  });

  it("returns null when this Codex has no such method", async () => {
    const rpc = fakeRpc(() => new Error("Method not found"));
    await expect(listCodexBackgroundTerminals(rpc, "thr_1")).resolves.toBeNull();
    const experimental = fakeRpc(
      () => new Error("thread/backgroundTerminals/list requires experimentalApi"),
    );
    await expect(
      listCodexBackgroundTerminals(experimental, "thr_1"),
    ).resolves.toBeNull();
  });

  it("passes other errors on", async () => {
    const rpc = fakeRpc(() => new Error("Harness process is not running"));
    await expect(listCodexBackgroundTerminals(rpc, "thr_1")).rejects.toThrow(
      "not running",
    );
  });

  it("treats a malformed reply as an empty list", async () => {
    const rpc = fakeRpc(() => ({ data: "nope" }));
    await expect(listCodexBackgroundTerminals(rpc, "thr_1")).resolves.toEqual(
      [],
    );
  });
});

describe("terminateCodexBackgroundTerminal", () => {
  it("terminates by process id and reads the answer", async () => {
    const rpc = fakeRpc(() => ({ terminated: true }));
    await expect(
      terminateCodexBackgroundTerminal(rpc, "thr_1", "42"),
    ).resolves.toBe(true);
    expect(rpc.calls).toEqual([
      [
        "thread/backgroundTerminals/terminate",
        { threadId: "thr_1", processId: "42" },
      ],
    ]);
  });

  it("is false when Codex says no or lacks the method", async () => {
    await expect(
      terminateCodexBackgroundTerminal(fakeRpc(() => ({ terminated: false })), "t", "1"),
    ).resolves.toBe(false);
    await expect(
      terminateCodexBackgroundTerminal(
        fakeRpc(() => new Error("unknown variant `thread/backgroundTerminals/terminate`")),
        "t",
        "1",
      ),
    ).resolves.toBe(false);
  });
});

describe("isMissingMethodError", () => {
  it("knows the shapes a missing method takes", () => {
    expect(isMissingMethodError(new Error("Method not found"))).toBe(true);
    expect(isMissingMethodError("codex error -32601")).toBe(true);
    expect(isMissingMethodError(new Error("timeout"))).toBe(false);
  });
});

describe("the Codex adapter", () => {
  it("answers no list and no stop with no live thread", async () => {
    vi.resetModules();
    const { listCodexBackgroundTasks, stopCodexBackgroundTask } = await import(
      "./codexBackground"
    );
    await expect(listCodexBackgroundTasks("none")).resolves.toBeNull();
    await expect(stopCodexBackgroundTask("none", "1")).resolves.toBe(false);
  });
});
