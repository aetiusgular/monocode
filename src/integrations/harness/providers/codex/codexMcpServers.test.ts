import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: Record<string, unknown>[] = [];
let onLine: ((line: string) => void) | undefined;
const spawnChild = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => undefined),
);
const killChild = vi.hoisted(() => vi.fn(async (_id: string) => undefined));
const releaseBridge = vi.hoisted(() => vi.fn());

vi.mock("../../core/child", () => ({
  acquireHarnessBridge: async () => releaseBridge,
  resolveCodexBinary: async () => ({ path: "/opt/wrapper/codex" }),
  spawnChild,
  killChild,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(JSON.parse(line) as Record<string, unknown>);
  },
}));
vi.mock("../../../../platform/tauri/fs", () => ({
  homeDir: async () => "/home/me",
}));

import { discoverCodexModels } from "./codexCatalog";
import {
  clearCodexMcpServersCache,
  listCodexMcpServers,
} from "./codexMcpServers";

const find = (method: string) =>
  sent.filter((message) => message.method === method);

const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

/** Answer the probe that is running with a `config/read` result or error. */
async function answer(config: Record<string, unknown> | Error) {
  await waitFor(() => find("initialize").length > 0, "initialize");
  onLine!(JSON.stringify({ id: find("initialize")[0].id, result: {} }));
  await waitFor(() => find("config/read").length > 0, "config/read");
  const read = find("config/read")[0];
  onLine!(
    JSON.stringify(
      config instanceof Error
        ? { id: read.id, error: { code: -32600, message: config.message } }
        : { id: read.id, result: { config, origins: {} } },
    ),
  );
  return read;
}

const GITHUB = { mcp_servers: { github: { command: "gh-mcp" } } };

beforeEach(() => {
  sent.length = 0;
  onLine = undefined;
  spawnChild.mockClear();
  killChild.mockClear();
  releaseBridge.mockClear();
  clearCodexMcpServersCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("listCodexMcpServers", () => {
  it("asks the session's own Codex for its configuration", async () => {
    const listed = listCodexMcpServers({
      cwd: "/repo",
      providerAccountId: "account-work",
    });
    const read = await answer({
      model: "gpt-5.4",
      mcp_servers: {
        linear: { url: "https://mcp.linear.app/mcp" },
        github: { command: "gh-mcp", enabled: false },
      },
    });
    expect(await listed).toEqual([
      { name: "github", enabled: false, command: "gh-mcp" },
      { name: "linear", enabled: true, url: "https://mcp.linear.app/mcp" },
    ]);

    // The configured binary, in the session's directory and account, the way
    // a session's own app-server is started.
    expect(spawnChild).toHaveBeenCalledTimes(1);
    const [id, path, args, cwd, account, binaryProvider] =
      spawnChild.mock.calls[0];
    expect([path, args, cwd, account, binaryProvider]).toEqual([
      "/opt/wrapper/codex",
      ["app-server"],
      "/repo",
      { provider: "codex", id: "account-work" },
      "codex",
    ]);
    expect(find("initialize")[0].params).toMatchObject({
      capabilities: { experimentalApi: true },
    });
    expect(find("initialized")).toHaveLength(1);
    expect(read.params).toEqual({ cwd: "/repo" });
    // The app-server lives only as long as the question.
    expect(killChild).toHaveBeenCalledWith(id);
    expect(releaseBridge).toHaveBeenCalledTimes(1);
  });

  it("uses the default account when the session has none", async () => {
    const listed = listCodexMcpServers({ cwd: "/repo" });
    await answer(GITHUB);
    await listed;
    expect(spawnChild.mock.calls[0][4]).toEqual({
      provider: "codex",
      id: "default",
    });
  });

  it("answers from the last result instead of starting Codex again", async () => {
    const first = listCodexMcpServers({ cwd: "/repo" });
    await answer(GITHUB);
    const servers = await first;
    expect(await listCodexMcpServers({ cwd: "/repo" })).toBe(servers);
    expect(spawnChild).toHaveBeenCalledTimes(1);
  });

  it("shares one probe between callers that ask at the same time", async () => {
    const first = listCodexMcpServers({ cwd: "/repo" });
    const second = listCodexMcpServers({ cwd: "/repo", refresh: true });
    await answer(GITHUB);
    expect(await second).toBe(await first);
    expect(spawnChild).toHaveBeenCalledTimes(1);
  });

  it("asks separately for another directory or account", async () => {
    const first = listCodexMcpServers({ cwd: "/repo" });
    await answer(GITHUB);
    await first;

    sent.length = 0;
    const elsewhere = listCodexMcpServers({ cwd: "/other" });
    await answer({ mcp_servers: {} });
    expect(await elsewhere).toEqual([]);

    sent.length = 0;
    const account = listCodexMcpServers({
      cwd: "/repo",
      providerAccountId: "account-work",
    });
    await answer({ mcp_servers: { linear: { url: "https://x" } } });
    expect((await account).map((server) => server.name)).toEqual(["linear"]);
    expect(spawnChild).toHaveBeenCalledTimes(3);
  });

  it("asks again on an explicit refresh", async () => {
    const first = listCodexMcpServers({ cwd: "/repo" });
    await answer(GITHUB);
    await first;

    sent.length = 0;
    const refreshed = listCodexMcpServers({ cwd: "/repo", refresh: true });
    await answer({ mcp_servers: { linear: { url: "https://x" } } });
    expect((await refreshed).map((server) => server.name)).toEqual(["linear"]);
    expect(spawnChild).toHaveBeenCalledTimes(2);
    // The refreshed answer is the one kept.
    expect(
      (await listCodexMcpServers({ cwd: "/repo" })).map((s) => s.name),
    ).toEqual(["linear"]);
    expect(spawnChild).toHaveBeenCalledTimes(2);
  });

  it("asks again once the answer is a minute old", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const first = listCodexMcpServers({ cwd: "/repo" });
    await answer(GITHUB);
    await first;

    now.mockReturnValue(1_000_000 + 59_000);
    await listCodexMcpServers({ cwd: "/repo" });
    expect(spawnChild).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000 + 60_000);
    sent.length = 0;
    const later = listCodexMcpServers({ cwd: "/repo" });
    await answer(GITHUB);
    await later;
    expect(spawnChild).toHaveBeenCalledTimes(2);
  });

  it("fails when Codex cannot be asked, and does not retry on every call", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const failed = listCodexMcpServers({ cwd: "/repo" });
    await answer(new Error("config/read is unavailable"));
    await expect(failed).rejects.toThrow("config/read is unavailable");
    expect(killChild).toHaveBeenCalledTimes(1);

    await expect(listCodexMcpServers({ cwd: "/repo" })).rejects.toThrow(
      "config/read is unavailable",
    );
    expect(spawnChild).toHaveBeenCalledTimes(1);

    // A refresh, or a little time, asks again.
    now.mockReturnValue(1_000_000 + 15_000);
    sent.length = 0;
    const retried = listCodexMcpServers({ cwd: "/repo" });
    await answer(GITHUB);
    expect((await retried).map((server) => server.name)).toEqual(["github"]);
    expect(spawnChild).toHaveBeenCalledTimes(2);
  });

  it("fails on a configuration it cannot read", async () => {
    const listed = listCodexMcpServers({ cwd: "/repo" });
    await answer({ mcp_servers: ["github"] });
    await expect(listed).rejects.toThrow("unreadable configuration");
  });

  it("fails when Codex cannot be started", async () => {
    spawnChild.mockRejectedValueOnce(new Error("codex: not found"));
    await expect(listCodexMcpServers({ cwd: "/repo" })).rejects.toThrow(
      "codex: not found",
    );
    expect(releaseBridge).toHaveBeenCalledTimes(1);
  });

  it("gives up on a Codex that does not answer", async () => {
    vi.useFakeTimers();
    const listed = listCodexMcpServers({ cwd: "/repo" });
    const outcome = expect(listed).rejects.toThrow(
      "Codex did not report its MCP servers in time",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
    expect(killChild).toHaveBeenCalled();
  });
});

describe("discoverCodexModels on the shared probe", () => {
  it("still asks the default Codex home for its models", async () => {
    const discovered = discoverCodexModels();
    await waitFor(() => find("initialize").length > 0, "initialize");
    onLine!(JSON.stringify({ id: find("initialize")[0].id, result: {} }));
    await waitFor(() => find("account/read").length > 0, "account/read");
    onLine!(
      JSON.stringify({
        id: find("account/read")[0].id,
        result: { account: { type: "chatgpt" } },
      }),
    );
    await waitFor(() => find("model/list").length > 0, "model/list");
    onLine!(
      JSON.stringify({
        id: find("model/list")[0].id,
        result: { data: [{ model: "gpt-5.4", displayName: "gpt-5.4" }] },
      }),
    );
    expect((await discovered).map((model) => model.nativeId)).toEqual([
      "gpt-5.4",
    ]);
    const [id, path, args, cwd, account, binaryProvider] =
      spawnChild.mock.calls[0];
    expect([path, args, cwd, account, binaryProvider]).toEqual([
      "/opt/wrapper/codex",
      ["app-server"],
      "/home/me",
      undefined,
      "codex",
    ]);
    expect(find("config/read")).toHaveLength(0);
    expect(killChild).toHaveBeenCalledWith(id);
  });
});
