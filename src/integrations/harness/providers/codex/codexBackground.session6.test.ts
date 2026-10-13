import { describe, expect, it } from "vitest";
import {
  listCodexBackgroundTerminals,
  type CodexRequester,
} from "./codexBackground";

// Mac test 1.8. Codex 0.161.0 lists a unified-exec command while the turn
// that started it still runs (contract check bg-terminals-mid-turn), so the
// Running section polls during the turn. A Codex without the methods must
// not be asked again every few seconds.

function fakeRpc(
  handler: (method: string) => unknown,
): CodexRequester & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request<T>(method: string): Promise<T> {
      calls.push(method);
      const result = handler(method);
      if (result instanceof Error) throw result;
      return result as T;
    },
  };
}

describe("Codex background terminals during a turn", () => {
  it("lists the command the turn is running, with a stop", async () => {
    // The reply recorded from Codex 0.161.0 while `sleep 120` ran in its turn.
    const rpc = fakeRpc(() => ({
      data: [
        {
          itemId: "bg1",
          processId: "67164",
          command: "sleep 120",
          cwd: "/repo",
          osPid: null,
          cpuPercent: null,
          rssKb: null,
        },
      ],
      nextCursor: null,
    }));
    await expect(listCodexBackgroundTerminals(rpc, "thr")).resolves.toEqual([
      {
        id: "67164",
        kind: "shell",
        title: "sleep 120",
        status: "running",
        stoppable: true,
        source: "harness",
      },
    ]);
  });

  it("asks a Codex without the method once per connection (corner case 11)", async () => {
    const rpc = fakeRpc(() => new Error("Method not found: thread/backgroundTerminals/list"));
    await expect(listCodexBackgroundTerminals(rpc, "thr")).resolves.toBeNull();
    await expect(listCodexBackgroundTerminals(rpc, "thr")).resolves.toBeNull();
    await expect(listCodexBackgroundTerminals(rpc, "thr")).resolves.toBeNull();
    expect(rpc.calls).toHaveLength(1);
    // A new app-server (a restarted Codex, maybe a newer one) is asked again.
    const next = fakeRpc(() => ({ data: [], nextCursor: null }));
    await expect(listCodexBackgroundTerminals(next, "thr")).resolves.toEqual([]);
    expect(next.calls).toHaveLength(1);
  });

  it("asks again after a transient failure", async () => {
    let fail = true;
    const rpc = fakeRpc(() => {
      if (fail) {
        fail = false;
        return new Error("thread/backgroundTerminals/list timed out");
      }
      return { data: [], nextCursor: null };
    });
    await expect(listCodexBackgroundTerminals(rpc, "thr")).rejects.toThrow(
      "timed out",
    );
    await expect(listCodexBackgroundTerminals(rpc, "thr")).resolves.toEqual([]);
    expect(rpc.calls).toHaveLength(2);
  });
});
