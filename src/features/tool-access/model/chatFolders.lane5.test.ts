import { describe, expect, it, vi } from "vitest";
import {
  chatFolders,
  claudeWritePath,
  codexChangePaths,
  codexRequestInsideChatFolders,
  lexicallyInside,
  literalAbsolutePath,
  MAX_CHECKED_PATHS,
  pathsInsideChatFolders,
  recordCodexFileChange,
  type CodexFileChangeLog,
} from "./chatFolders";

const yes = async () => true;
const no = async () => false;

describe("literalAbsolutePath", () => {
  it("keeps names literally and drops . and empty parts", () => {
    expect(literalAbsolutePath("/repo/./src//a.ts")).toBe("/repo/src/a.ts");
    expect(literalAbsolutePath("/repo/name with spaces.txt")).toBe(
      "/repo/name with spaces.txt",
    );
    expect(literalAbsolutePath("/repo/-rf")).toBe("/repo/-rf");
    expect(literalAbsolutePath("/repo/$(touch x)")).toBe("/repo/$(touch x)");
  });

  it("refuses .., NUL, empty and relative paths without a base", () => {
    expect(literalAbsolutePath("/repo/../etc/passwd")).toBeNull();
    expect(literalAbsolutePath("/repo/a/..")).toBeNull();
    expect(literalAbsolutePath("/repo/a\0b")).toBeNull();
    expect(literalAbsolutePath("")).toBeNull();
    expect(literalAbsolutePath("a.txt")).toBeNull();
    expect(literalAbsolutePath("a.txt", "relative/base")).toBeNull();
  });

  it("reads a relative path against the base", () => {
    expect(literalAbsolutePath("src/a.ts", "/repo/")).toBe("/repo/src/a.ts");
    expect(literalAbsolutePath("../x", "/repo")).toBeNull();
  });
});

describe("chatFolders", () => {
  it("puts the working folder first, dedupes, and never takes the root", () => {
    expect(chatFolders("/repo", ["/docs/", "/repo", "/", "rel", ""])).toEqual([
      "/repo",
      "/docs",
    ]);
    expect(chatFolders(undefined)).toEqual([]);
  });
});

describe("lexicallyInside", () => {
  it("does not take a sibling with the same prefix", () => {
    expect(lexicallyInside("/repo-evil/x", ["/repo"])).toBe(false);
    expect(lexicallyInside("/repo", ["/repo"])).toBe(true);
    expect(lexicallyInside("/repo/a", ["/other", "/repo"])).toBe(true);
  });
});

describe("pathsInsideChatFolders", () => {
  it("passes paths inside the working folder or an added folder", async () => {
    const disk = vi.fn(yes);
    expect(
      await pathsInsideChatFolders(
        ["/repo/a.ts", "/docs/b.md", "src/c.ts"],
        ["/repo", "/docs"],
        disk,
      ),
    ).toBe(true);
    expect(disk).toHaveBeenCalledWith(
      ["/repo", "/docs"],
      ["/repo/a.ts", "/docs/b.md", "/repo/src/c.ts"],
    );
  });

  it("refuses outside, .., and the sibling prefix without asking the disk", async () => {
    const disk = vi.fn(yes);
    for (const path of ["/etc/hosts", "/repo/../etc/hosts", "/repo-evil/a"]) {
      expect(await pathsInsideChatFolders([path], ["/repo"], disk)).toBe(false);
    }
    expect(disk).not.toHaveBeenCalled();
  });

  it("refuses when one path of several is outside", async () => {
    expect(
      await pathsInsideChatFolders(["/repo/a", "/tmp/b"], ["/repo"], yes),
    ).toBe(false);
  });

  it("takes names with spaces or a leading dash literally", async () => {
    expect(
      await pathsInsideChatFolders(
        ["/repo/my file.txt", "/repo/-rf", "/repo/--help"],
        ["/repo"],
        yes,
      ),
    ).toBe(true);
  });

  it("refuses what the disk check refuses, such as a symlink out", async () => {
    expect(await pathsInsideChatFolders(["/repo/link/a"], ["/repo"], no)).toBe(
      false,
    );
  });

  it("fails closed when the disk check throws or answers oddly", async () => {
    const throws = async () => {
      throw new Error("not in Tauri");
    };
    expect(await pathsInsideChatFolders(["/repo/a"], ["/repo"], throws)).toBe(
      false,
    );
    const odd = async () => "true" as unknown as boolean;
    expect(await pathsInsideChatFolders(["/repo/a"], ["/repo"], odd)).toBe(
      false,
    );
  });

  it("refuses unknown, empty, too many, or folderless requests", async () => {
    expect(await pathsInsideChatFolders(null, ["/repo"], yes)).toBe(false);
    expect(await pathsInsideChatFolders([], ["/repo"], yes)).toBe(false);
    expect(await pathsInsideChatFolders(["/repo/a"], [], yes)).toBe(false);
    const many = Array.from(
      { length: MAX_CHECKED_PATHS + 1 },
      (_, i) => `/repo/${i}`,
    );
    expect(await pathsInsideChatFolders(many, ["/repo"], yes)).toBe(false);
  });
});

describe("codexChangePaths", () => {
  it("lists each path and a move's destination", () => {
    expect(
      codexChangePaths([
        { path: "/repo/a", kind: { type: "add" } },
        { path: "/repo/b", kind: { type: "update", move_path: "/repo/c" } },
        { path: "/repo/d", kind: { type: "update", movePath: "/tmp/e" } },
      ]),
    ).toEqual(["/repo/a", "/repo/b", "/repo/c", "/repo/d", "/tmp/e"]);
  });

  it("is null when any change is unreadable", () => {
    expect(codexChangePaths([{ kind: { type: "add" } }])).toBeNull();
    expect(codexChangePaths([{ path: 3 }])).toBeNull();
    expect(
      codexChangePaths([{ path: "/repo/a", kind: { move_path: 7 } }]),
    ).toBeNull();
    expect(codexChangePaths([])).toBeNull();
    expect(codexChangePaths("nope")).toBeNull();
  });
});

describe("recordCodexFileChange", () => {
  const started = (id: string, changes: unknown) => ({
    item: { type: "fileChange", id, changes, status: "inProgress" },
  });

  it("records fileChange items and merges patch updates", () => {
    const log: CodexFileChangeLog = new Map();
    recordCodexFileChange(
      log,
      "item/started",
      started("e1", [{ path: "/repo/a" }]),
    );
    recordCodexFileChange(log, "item/fileChange/patchUpdated", {
      itemId: "e1",
      changes: [{ path: "/repo/b" }, { path: "/repo/a" }],
    });
    expect(log.get("e1")).toEqual(["/repo/a", "/repo/b"]);
  });

  it("poisons an item once an unreadable report arrives", () => {
    const log: CodexFileChangeLog = new Map();
    recordCodexFileChange(
      log,
      "item/started",
      started("e1", [{ path: "/repo/a" }]),
    );
    recordCodexFileChange(log, "item/fileChange/patchUpdated", {
      itemId: "e1",
      changes: [{}],
    });
    recordCodexFileChange(
      log,
      "item/completed",
      started("e1", [{ path: "/repo/a" }]),
    );
    expect(log.get("e1")).toBeNull();
  });

  it("ignores other items and methods, and keeps at most 200", () => {
    const log: CodexFileChangeLog = new Map();
    recordCodexFileChange(log, "item/started", {
      item: { type: "commandExecution", id: "c1" },
    });
    recordCodexFileChange(log, "turn/started", { item: started("x", []) });
    recordCodexFileChange(log, "item/started", null);
    expect(log.size).toBe(0);
    for (let i = 0; i < 250; i++)
      recordCodexFileChange(
        log,
        "item/started",
        started(`e${i}`, [{ path: "/repo/a" }]),
      );
    expect(log.size).toBe(200);
    expect(log.has("e0")).toBe(false);
    expect(log.has("e249")).toBe(true);
  });
});

describe("codexRequestInsideChatFolders", () => {
  const log: CodexFileChangeLog = new Map([
    ["in", ["/repo/a"]],
    ["out", ["/etc/hosts"]],
    ["bad", null],
  ]);
  const check = (method: string, params: unknown) =>
    codexRequestInsideChatFolders(log, ["/repo"], method, params, yes);

  it("passes a command, which names no files", async () => {
    expect(
      await check("item/commandExecution/requestApproval", { itemId: "c" }),
    ).toBe(true);
  });

  it("holds a file change to the chat's folders", async () => {
    const FILE = "item/fileChange/requestApproval";
    expect(await check(FILE, { itemId: "in" })).toBe(true);
    expect(await check(FILE, { itemId: "out" })).toBe(false);
    expect(await check(FILE, { itemId: "bad" })).toBe(false);
    expect(await check(FILE, { itemId: "never-seen" })).toBe(false);
    expect(await check(FILE, {})).toBe(false);
  });
});

describe("claudeWritePath", () => {
  it("names the file of the file tools only", () => {
    expect(claudeWritePath("Write", { file_path: "/repo/a" })).toBe("/repo/a");
    expect(claudeWritePath("Edit", { file_path: "/repo/a" })).toBe("/repo/a");
    expect(claudeWritePath("MultiEdit", { file_path: "/repo/a" })).toBe(
      "/repo/a",
    );
    expect(
      claudeWritePath("NotebookEdit", { notebook_path: "/r/n.ipynb" }),
    ).toBe("/r/n.ipynb");
    expect(claudeWritePath("Write", {})).toBeNull();
    expect(claudeWritePath("Bash", { command: "ls" })).toBeUndefined();
  });
});
