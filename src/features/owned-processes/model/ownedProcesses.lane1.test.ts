import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendBoundedOutput,
  clearOwnedProcess,
  describeCommand,
  getOwnedProcess,
  MAX_PROCESSES_PER_SESSION,
  ownedProcessItem,
  ownedProcessesForSession,
  ownedProcessesVersion,
  resetOwnedProcessesForTest,
  setOwnedProcessPtyForTest,
  startOwnedProcess,
  stopOwnedProcess,
  stopOwnedProcessesForSession,
  subscribeOwnedProcesses,
  type StartOwnedProcessInput,
} from "./ownedProcesses";
import type { PtyCommand } from "../../../platform/tauri/pty";

type Handlers = {
  data: (bytes: Uint8Array) => void;
  exit: (code: number | null) => void;
};

const handlers = new Map<string, Handlers>();
const spawn = vi.fn(
  async (
    _id: string,
    _cwd: string,
    _cols: number,
    _rows: number,
    _command?: PtyCommand,
  ) => undefined,
);
const kill = vi.fn(async (id: string) => {
  handlers.delete(id);
});

const input = (patch: Partial<StartOwnedProcessInput> = {}) =>
  ({
    sessionId: "s1",
    cwd: "/repo",
    title: "Dev server",
    kind: "server",
    command: { program: "npm", args: ["run", "dev"], env: { PORT: "5173" } },
    confirmedByUser: true,
    ...patch,
  }) as StartOwnedProcessInput;

const encode = (text: string) => new TextEncoder().encode(text);

beforeEach(() => {
  handlers.clear();
  spawn.mockClear();
  kill.mockClear();
  setOwnedProcessPtyForTest({
    spawn,
    kill,
    subscribe: (id, data, exit) => {
      handlers.set(id, { data, exit });
      return () => handlers.delete(id);
    },
  });
});

afterEach(() => {
  resetOwnedProcessesForTest();
  setOwnedProcessPtyForTest(null);
});

describe("startOwnedProcess", () => {
  it("starts the confirmed command as a list, in the project folder", async () => {
    const process = await startOwnedProcess(input());
    expect(process.status).toBe("running");
    expect(process.id).toMatch(/^owned-/);
    expect(spawn).toHaveBeenCalledWith(process.id, "/repo", 120, 32, {
      program: "npm",
      args: ["run", "dev"],
      env: { PORT: "5173" },
    });
  });

  it("refuses without confirmation, a folder or a usable command", async () => {
    await expect(
      startOwnedProcess({
        ...input(),
        confirmedByUser: false as unknown as true,
      }),
    ).rejects.toThrow("confirmation");
    await expect(startOwnedProcess(input({ cwd: "" }))).rejects.toThrow(
      "folder",
    );
    await expect(startOwnedProcess(input({ cwd: "~" }))).rejects.toThrow(
      "folder",
    );
    await expect(
      startOwnedProcess(input({ command: { program: "  " } })),
    ).rejects.toThrow("cannot be started");
    await expect(
      startOwnedProcess(input({ command: { program: "npm", args: ["a\0b"] } })),
    ).rejects.toThrow("cannot be started");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("caps how many run for one chat", async () => {
    for (let i = 0; i < MAX_PROCESSES_PER_SESSION; i += 1) {
      await startOwnedProcess(input());
    }
    await expect(startOwnedProcess(input())).rejects.toThrow("At most");
    // Another chat is not affected.
    await expect(startOwnedProcess(input({ sessionId: "s2" }))).resolves
      .toBeTruthy();
  });

  it("keeps the output, including what arrives before the spawn returns", async () => {
    spawn.mockImplementationOnce(async (id) => {
      handlers.get(id)?.data(encode("booting\n"));
    });
    const process = await startOwnedProcess(input());
    handlers.get(process.id)?.data(encode("ready on :5173\n"));
    expect(getOwnedProcess(process.id)?.output).toBe(
      "booting\nready on :5173\n",
    );
  });

  it("decodes a character split across chunks", async () => {
    const process = await startOwnedProcess(input());
    const bytes = encode("é");
    handlers.get(process.id)?.data(bytes.slice(0, 1));
    handlers.get(process.id)?.data(bytes.slice(1));
    expect(getOwnedProcess(process.id)?.output).toBe("é");
  });

  it("records a failed start without leaving a listener", async () => {
    spawn.mockRejectedValueOnce(new Error("The folder for this process does not exist"));
    const process = await startOwnedProcess(input());
    expect(process.status).toBe("failed");
    expect(process.error).toContain("does not exist");
    expect(handlers.size).toBe(0);
    expect(ownedProcessItem(process).status).toBe("failed");
  });

  it("marks a quick command exited even if it ends before the spawn returns", async () => {
    spawn.mockImplementationOnce(async (id) => {
      handlers.get(id)?.exit(0);
    });
    const process = await startOwnedProcess(input());
    expect(process.status).toBe("exited");
    expect(ownedProcessItem(process)).toMatchObject({
      status: "done",
      stoppable: false,
      source: "monocode",
    });
  });
});

describe("stopping and clearing", () => {
  it("stops one process and keeps its output", async () => {
    const process = await startOwnedProcess(input());
    handlers.get(process.id)?.data(encode("log line\n"));
    await expect(stopOwnedProcess(process.id)).resolves.toBe(true);
    expect(kill).toHaveBeenCalledWith(process.id);
    expect(getOwnedProcess(process.id)).toMatchObject({
      status: "exited",
      output: "log line\n",
    });
    await expect(stopOwnedProcess(process.id)).resolves.toBe(false);
  });

  it("stops every process of a session and no other", async () => {
    const a = await startOwnedProcess(input());
    const b = await startOwnedProcess(input());
    const other = await startOwnedProcess(input({ sessionId: "s2" }));
    await stopOwnedProcessesForSession("s1");
    expect(kill.mock.calls.map(([id]) => id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(getOwnedProcess(other.id)?.status).toBe("running");
  });

  it("clears only finished processes", async () => {
    const process = await startOwnedProcess(input());
    expect(clearOwnedProcess(process.id)).toBe(false);
    handlers.get(process.id)?.exit(1);
    expect(ownedProcessItem(getOwnedProcess(process.id)!).status).toBe(
      "failed",
    );
    expect(clearOwnedProcess(process.id)).toBe(true);
    expect(ownedProcessesForSession("s1")).toEqual([]);
  });

  it("tells subscribers about every change", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOwnedProcesses(listener);
    const before = ownedProcessesVersion();
    await startOwnedProcess(input());
    expect(listener).toHaveBeenCalled();
    expect(ownedProcessesVersion()).toBeGreaterThan(before);
    unsubscribe();
  });
});

describe("appendBoundedOutput", () => {
  it("keeps the newest text, cut at a line start", () => {
    const out = appendBoundedOutput("aaaa\nbbbb\n", "cccc\n", 12);
    expect(out).toBe("bbbb\ncccc\n");
    expect(appendBoundedOutput("ab", "cd", 3)).toBe("bcd");
    expect(appendBoundedOutput("ab", "cd", 10)).toBe("abcd");
  });
});

describe("describeCommand", () => {
  it("quotes anything a shell would read as more than one word", () => {
    expect(
      describeCommand({ program: "npm", args: ["run", "dev; rm -rf ~", "it's"] }),
    ).toBe("npm run 'dev; rm -rf ~' 'it'\\''s'");
  });
});
