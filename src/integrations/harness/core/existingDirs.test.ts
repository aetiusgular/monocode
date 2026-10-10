import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const { existingDirs } = await import("./existingDirs");

describe("existingDirs", () => {
  // A returned value would be taken for a teardown function, so use a block.
  beforeEach(() => {
    invoke.mockReset();
  });

  it("keeps folders that exist and drops missing paths and plain files", async () => {
    invoke.mockImplementation(
      async (_command: string, args: { paths: string[] }) => {
        const [path] = args.paths;
        if (path === "/work/docs") return [{ path, isDir: true }];
        if (path === "/work/notes.md") return [{ path, isDir: false }];
        return [];
      },
    );
    expect(
      await existingDirs(["/work/docs", "/work/gone", "/work/notes.md"]),
    ).toEqual(["/work/docs"]);
    expect(invoke).toHaveBeenCalledWith("inspect_paths", {
      paths: ["/work/docs"],
    });
  });

  it("asks nothing for an empty list", async () => {
    expect(await existingDirs(undefined)).toEqual([]);
    expect(await existingDirs([])).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("passes the list through when the check cannot run", async () => {
    invoke.mockRejectedValue(new Error("no backend"));
    expect(await existingDirs(["/work/docs"])).toEqual(["/work/docs"]);
  });
});
