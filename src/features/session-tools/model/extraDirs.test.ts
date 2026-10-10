import { describe, expect, it } from "vitest";
import {
  MAX_EXTRA_DIRS,
  addExtraDirs,
  extraDirName,
  harnessExtraDirs,
  pendingExtraDirs,
  removeExtraDir,
  sanitizeExtraDirs,
} from "./extraDirs";
import { sessionToolsInput } from "./harnessInput";

describe("addExtraDirs", () => {
  it("adds picked folders in order", () => {
    expect(addExtraDirs([], ["/work/docs", "/work/design"], ["/repo"])).toEqual(
      ["/work/docs", "/work/design"],
    );
  });

  it("skips a folder that is already listed", () => {
    const current = ["/work/docs"];
    expect(addExtraDirs(current, ["/work/docs"], ["/repo"])).toBe(current);
    expect(addExtraDirs(current, ["/work/docs/"], ["/repo"])).toBe(current);
    expect(
      addExtraDirs([], ["/work/docs", "/work/docs", "/work/docs/"], []),
    ).toEqual(["/work/docs"]);
  });

  it("compares Windows paths without regard to case or slash style", () => {
    expect(
      addExtraDirs(["C:/Work/Docs"], ["c:\\work\\docs"], ["D:/repo"]),
    ).toEqual(["C:/Work/Docs"]);
    expect(addExtraDirs([], ["C:\\Work\\Docs\\"], ["D:/repo"])).toEqual([
      "C:/Work/Docs",
    ]);
  });

  it("skips the working directory and anything inside it", () => {
    const current: string[] = [];
    expect(addExtraDirs(current, ["/repo"], ["/repo"])).toBe(current);
    expect(addExtraDirs(current, ["/repo/"], ["/repo"])).toBe(current);
    expect(addExtraDirs(current, ["/repo/packages/app"], ["/repo"])).toBe(
      current,
    );
  });

  it("checks every working directory, so a worktree counts too", () => {
    expect(
      addExtraDirs(
        [],
        ["/repo/src", "/worktrees/feature/src", "/elsewhere"],
        ["/repo", "/worktrees/feature"],
      ),
    ).toEqual(["/elsewhere"]);
  });

  it("keeps a sibling whose name only starts like the working directory", () => {
    expect(addExtraDirs([], ["/repo-docs"], ["/repo"])).toEqual(["/repo-docs"]);
  });

  it("keeps a folder that contains the working directory", () => {
    expect(addExtraDirs([], ["/work"], ["/work/repo"])).toEqual(["/work"]);
  });

  it("does not treat a placeholder working directory as covering anything", () => {
    expect(addExtraDirs([], ["/work/docs"], ["~", ""])).toEqual(["/work/docs"]);
  });

  it("ignores paths that are not absolute", () => {
    const current: string[] = [];
    expect(addExtraDirs(current, ["docs", "./docs", "~/docs", ""], [])).toBe(
      current,
    );
  });

  it("stops at the limit", () => {
    const picked = Array.from(
      { length: MAX_EXTRA_DIRS + 5 },
      (_, index) => `/work/${index}`,
    );
    expect(addExtraDirs([], picked, [])).toHaveLength(MAX_EXTRA_DIRS);
  });
});

describe("removeExtraDir", () => {
  it("removes the matching folder only", () => {
    expect(removeExtraDir(["/a", "/b"], "/a/")).toEqual(["/b"]);
    expect(removeExtraDir(["/a", "/b"], "/c")).toEqual(["/a", "/b"]);
  });
});

describe("sanitizeExtraDirs", () => {
  it("keeps absolute, unique string paths", () => {
    expect(sanitizeExtraDirs(["/a", 3, null, "/a/", "relative", "/b"])).toEqual(
      ["/a", "/b"],
    );
  });

  it("is undefined for anything that leaves no folder", () => {
    expect(sanitizeExtraDirs(undefined)).toBeUndefined();
    expect(sanitizeExtraDirs("/a")).toBeUndefined();
    expect(sanitizeExtraDirs([])).toBeUndefined();
    expect(sanitizeExtraDirs(["relative"])).toBeUndefined();
  });
});

describe("harnessExtraDirs", () => {
  it("passes folders to Claude Code and Codex only", () => {
    expect(harnessExtraDirs("claude", ["/a"], "/repo")).toEqual(["/a"]);
    expect(harnessExtraDirs("codex", ["/a"], "/repo")).toEqual(["/a"]);
    for (const harness of ["cursor", "opencode", "grok", "pi"] as const)
      expect(harnessExtraDirs(harness, ["/a"], "/repo")).toBeUndefined();
  });

  it("drops folders the current working directory now covers", () => {
    expect(harnessExtraDirs("claude", ["/repo/docs", "/a"], "/repo")).toEqual([
      "/a",
    ]);
    expect(harnessExtraDirs("claude", ["/repo/docs"], "/repo")).toBeUndefined();
    expect(harnessExtraDirs("claude", undefined, "/repo")).toBeUndefined();
  });

  it("is what a harness turn receives", () => {
    expect(
      sessionToolsInput({ harness: "codex", extraDirs: ["/a"] }, "/repo"),
    ).toEqual({ extraDirs: ["/a"] });
    expect(
      sessionToolsInput({ harness: "cursor", extraDirs: ["/a"] }, "/repo"),
    ).toEqual({});
    expect(sessionToolsInput({ harness: "codex" }, "/repo")).toEqual({});
  });
});

describe("extraDirName", () => {
  it("uses the last path segment", () => {
    expect(extraDirName("/work/docs")).toBe("docs");
    expect(extraDirName("/work/docs/")).toBe("docs");
    expect(extraDirName("C:\\Work\\Docs")).toBe("Docs");
    expect(extraDirName("/")).toBe("/");
    expect(extraDirName("C:\\")).toBe("C:/");
  });
});

describe("pendingExtraDirs", () => {
  it("is empty while no turn is running", () => {
    expect(pendingExtraDirs(["/a"], null).size).toBe(0);
  });

  it("holds only folders added after the turn started", () => {
    expect([...pendingExtraDirs(["/a", "/b"], ["/a"])]).toEqual(["/b"]);
    expect(pendingExtraDirs(["/a"], ["/a", "/gone"]).size).toBe(0);
  });
});
