import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
const spawned: { args: string[]; account?: unknown }[] = [];
const killed: string[] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("../../../../platform/tauri/fs", () => ({
  homeDir: async () => "/home/me",
}));
vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async (
    _id: string,
    _path: string,
    args: string[],
    _cwd: string,
    account?: unknown,
  ) => {
    spawned.push({ args, account });
  },
  killChild: async (id: string) => {
    killed.push(id);
  },
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
}));

const { probeClaudeMcpServers } = await import("./claudeMcpStatus");

const requests = () =>
  sent.map((line) => JSON.parse(line) as Record<string, any>);
const statusAsks = () =>
  requests().filter((m) => m.request?.subtype === "mcp_status").length;

function answer(servers: { name: string; status: string }[]) {
  onLine!(
    JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "monocode_mcp_status",
        response: { mcpServers: servers },
      },
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  spawned.length = 0;
  killed.length = 0;
  onLine = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("probeClaudeMcpServers", () => {
  it("starts Claude Code without a prompt and asks for its servers", async () => {
    const result = probeClaudeMcpServers({ providerAccountId: "work" });
    await vi.advanceTimersByTimeAsync(0);
    const { args, account } = spawned[0];
    expect(account).toEqual({ provider: "claude", id: "work" });
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--setting-sources=user,project,local");
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    expect(settings.disableAllHooks).toBe(true);
    expect(requests()[0].request.subtype).toBe("initialize");
    expect(requests().some((m) => m.type === "user")).toBe(false);

    await vi.advanceTimersByTimeAsync(1500);
    expect(statusAsks()).toBe(1);
    answer([{ name: "claude.ai Exa", status: "connected" }]);
    await expect(result).resolves.toEqual([
      { name: "claude.ai Exa", status: "connected" },
    ]);
    expect(killed).toHaveLength(1);
  });

  it("asks again while servers are still connecting", async () => {
    const result = probeClaudeMcpServers({});
    await vi.advanceTimersByTimeAsync(1500);
    answer([{ name: "claude.ai Exa", status: "pending" }]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(statusAsks()).toBe(2);
    answer([{ name: "claude.ai Exa", status: "connected" }]);
    await expect(result).resolves.toEqual([
      { name: "claude.ai Exa", status: "connected" },
    ]);
  });

  it("settles on the last answer when a server never finishes", async () => {
    const result = probeClaudeMcpServers({});
    await vi.advanceTimersByTimeAsync(1500);
    for (let i = 0; i < 6; i += 1) {
      answer([{ name: "slow", status: "pending" }]);
      await vi.advanceTimersByTimeAsync(1500);
    }
    answer([{ name: "slow", status: "pending" }]);
    await expect(result).resolves.toEqual([
      { name: "slow", status: "pending" },
    ]);
    expect(killed).toHaveLength(1);
  });

  it("fails when Claude Code never answers", async () => {
    const result = probeClaudeMcpServers({});
    const settled = expect(result).rejects.toThrow("did not list its servers");
    await vi.advanceTimersByTimeAsync(15_000);
    await settled;
    expect(killed).toHaveLength(1);
  });
});
