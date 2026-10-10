import { describe, expect, it } from "vitest";
import type { SessionFolder } from "./sessionResources";
import type { SessionToolUse, UseItem } from "./sessionToolUse";
import { usedActionLabel, usedRows } from "./sessionUsedRows";

function use(patch: Partial<SessionToolUse["items"]> = {}): SessionToolUse {
  return {
    mcpServers: [],
    webSearches: 0,
    webFetches: 0,
    projectSearches: 0,
    commands: 0,
    filesRead: 0,
    filesEdited: 0,
    subagents: 0,
    otherTools: 0,
    items: {
      webSearches: [],
      webFetches: [],
      projectSearches: [],
      commands: [],
      filesRead: [],
      filesEdited: [],
      subagents: [],
      otherTools: [],
      ...patch,
    },
  };
}

function item(label: string, blockId: string, more: Partial<UseItem> = {}) {
  return { label, blockId, calls: 1, ...more };
}

const WORK: SessionFolder = {
  path: "/work/app",
  name: "app",
  shown: "~/app",
  role: "working",
};

describe("usedRows", () => {
  it("lists nothing for a session with no folder that has used nothing", () => {
    expect(usedRows({ attachments: [], folders: [], use: use() })).toEqual([]);
  });

  it("keeps a fixed order and leaves out what was not used", () => {
    const rows = usedRows({
      attachments: [],
      folders: [WORK],
      use: use({
        commands: [item("npm test", "c1")],
        webFetches: [item("WebFetch", "w1")],
        otherTools: [item("Thing", "o1")],
      }),
    });
    expect(rows.map((row) => row.id)).toEqual([
      "folders",
      "commands",
      "web",
      "other",
    ]);
  });

  it("opens an attachment's file, or its message when it has none", () => {
    const [row] = usedRows({
      attachments: [
        { key: "u:1", name: "a.png", kind: "image", blockId: "u" },
        {
          key: "u:2",
          name: "b.log",
          kind: "file",
          blockId: "u",
          path: "/tmp/b.log",
        },
      ],
      folders: [],
      use: use(),
    });
    expect(row).toMatchObject({ preview: "a.png", more: 1, total: 2 });
    expect(row.groups[0].entries.map((entry) => entry.action)).toEqual([
      { kind: "chat", blockId: "u" },
      { kind: "open", path: "/tmp/b.log" },
    ]);
  });

  it("reveals a folder and says which one the session works in", () => {
    const [row] = usedRows({
      attachments: [],
      folders: [
        WORK,
        { path: "/work/sdk", name: "sdk", shown: "~/sdk", role: "added" },
      ],
      use: use(),
    });
    expect(row).toMatchObject({ preview: "~/app", more: 1 });
    expect(row.groups[0].entries).toMatchObject([
      {
        label: "app",
        detail: "Working folder",
        sub: ["~/app"],
        action: { kind: "reveal", path: "/work/app" },
      },
      { label: "sdk", detail: "Added", sub: ["~/sdk"] },
    ]);
  });

  it("lists a connector's tools under it", () => {
    const [row] = usedRows({
      attachments: [],
      folders: [],
      use: {
        ...use(),
        mcpServers: [
          {
            server: "github",
            calls: 3,
            tools: [
              { name: "get_issue", calls: 2 },
              { name: "list_issues", calls: 1 },
            ],
            blockId: "m3",
          },
        ],
      },
    });
    expect(row.groups[0].entries).toMatchObject([
      {
        label: "github",
        detail: "3 calls",
        sub: ["get_issue ×2", "list_issues"],
        action: { kind: "chat", blockId: "m3" },
      },
    ]);
  });

  it("splits files into edited and read, each by name with its folder", () => {
    const [row] = usedRows({
      attachments: [],
      folders: [],
      use: use({
        filesEdited: [
          item("src/app/main.ts", "e1", { path: "/r/src/app/main.ts" }),
        ],
        filesRead: [item("README.md", "r1"), item("src/a.ts", "r2")],
      }),
    });
    expect(row).toMatchObject({
      id: "files",
      preview: "1 edited · 2 read",
      more: 0,
      total: 3,
    });
    expect(row.groups.map((group) => group.title)).toEqual(["Edited", "Read"]);
    expect(row.groups[0].entries[0]).toMatchObject({
      label: "main.ts",
      detail: "src/app",
      full: "src/app/main.ts",
      action: { kind: "open", path: "/r/src/app/main.ts" },
    });
    // No path to open: the row leads back to the call.
    expect(row.groups[1].entries[0]).toMatchObject({
      label: "README.md",
      action: { kind: "chat", blockId: "r1" },
    });
    expect(row.groups[1].entries[0].detail).toBeUndefined();
  });

  it("previews the latest command and marks one that ran more than once", () => {
    const [row] = usedRows({
      attachments: [],
      folders: [],
      use: use({
        commands: [
          item("npm test", "c3", { calls: 2 }),
          item("git status", "c2"),
        ],
      }),
    });
    expect(row).toMatchObject({ preview: "git status", more: 1, total: 2 });
    expect(row.groups[0].entries.map((entry) => entry.detail)).toEqual([
      "×2",
      undefined,
    ]);
  });

  it("puts searches before pages under Web", () => {
    const [row] = usedRows({
      attachments: [],
      folders: [],
      use: use({
        webSearches: [item("idempotency keys", "s1")],
        webFetches: [item("WebFetch", "f1")],
      }),
    });
    expect(row).toMatchObject({ preview: "idempotency keys", more: 1 });
    expect(row.groups.map((group) => group.title)).toEqual([
      "Searches",
      "Pages",
    ]);
  });
});

describe("usedActionLabel", () => {
  it("names what a click does", () => {
    expect(usedActionLabel({ kind: "open", path: "/a" }, "Reveal")).toBe(
      "Open file",
    );
    expect(usedActionLabel({ kind: "reveal", path: "/a" }, "Reveal")).toBe(
      "Reveal",
    );
    expect(usedActionLabel({ kind: "chat", blockId: "b" }, "Reveal")).toBe(
      "Show in chat",
    );
  });
});
