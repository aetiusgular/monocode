import { describe, expect, it } from "vitest";
import { applyHarnessEvents } from "../../../integrations/harness/core/apply";
import { extractToolPreview } from "../../../integrations/harness/core/preview";
import type { HarnessEvent } from "../../../integrations/harness/core/types";
import {
  previewFromTool,
  toolKindFromName,
  toolTitle,
} from "../../../integrations/harness/providers/claude/claudeProtocol";
import { mapCodexNotification } from "../../../integrations/harness/providers/codex/codexProtocol";
import {
  newSession,
  type Block,
  type HarnessId,
} from "../../sessions/model/session";
import {
  DOCUMENT_EXTENSIONS,
  MAX_DOCUMENT_CARDS,
  collectTurnDocuments,
  documentCardWindow,
  documentExtension,
  documentRelativePath,
  documentTypeLabel,
  isExcludedDocumentPath,
} from "./documentFiles";

const CWD = "/Users/ada/project";

/** Blocks as the app stores them after a harness reported these events. */
function blocksFrom(harness: HarnessId, events: HarnessEvent[]): Block[] {
  return applyHarnessEvents(newSession(harness, CWD), events).blocks;
}

/** One Claude Code tool call, from its tool_use to its tool_result. */
function claudeCall(
  callId: string,
  name: string,
  input: Record<string, unknown>,
  outcome: "completed" | "failed" | "running" = "completed",
): HarnessEvent[] {
  const started: HarnessEvent = {
    type: "tool.started",
    callId,
    title: toolTitle(name, input),
    kind: toolKindFromName(name),
    status: "pending",
    preview: previewFromTool(name, input),
  };
  if (outcome === "running") return [started];
  return [
    started,
    {
      type: "tool.updated",
      callId,
      title: toolTitle(name, input),
      kind: toolKindFromName(name),
      status: outcome,
      detail: outcome === "failed" ? "File has not been read yet." : "ok",
      preview: previewFromTool(name, input, "ok"),
    },
  ];
}

type CodexChange = { path: string; kind: string; diff: string };

/** One Codex fileChange item, from item/started to item/completed. */
function codexPatch(
  id: string,
  changes: CodexChange[],
  status = "completed",
): HarnessEvent[] {
  return [
    ...mapCodexNotification("item/started", {
      item: { id, type: "fileChange", status: "inProgress", changes },
    }).events,
    ...mapCodexNotification("item/completed", {
      item: { id, type: "fileChange", status, changes },
    }).events,
  ];
}

function paths(blocks: Block[], options = {}): string[] {
  return collectTurnDocuments(blocks, { cwd: CWD, ...options }).map(
    (file) => file.relativePath,
  );
}

describe("document extensions", () => {
  it("keeps one list of what counts as a document", () => {
    expect([...DOCUMENT_EXTENSIONS]).toEqual([
      "md",
      "mdx",
      "markdown",
      "txt",
      "rst",
      "adoc",
      "pdf",
      "docx",
      "csv",
      "tsv",
      "html",
    ]);
  });

  it("reads the extension whatever its case", () => {
    expect(documentExtension("/tmp/Report.PDF")).toBe("pdf");
    expect(documentExtension("docs/plan.md")).toBe("md");
    expect(documentExtension("C:\\work\\notes.TXT")).toBe("txt");
  });

  it("does not treat data or source files as documents", () => {
    for (const name of [
      "data.json",
      "src/App.tsx",
      "main.rs",
      "styles.css",
      "config.yaml",
      "Makefile",
      ".md",
      "notes.md.bak",
    ]) {
      expect(documentExtension(name), name).toBeUndefined();
    }
  });

  it("labels a document by what it is", () => {
    expect(documentTypeLabel("docs/plan.md")).toBe("Document · MD");
    expect(documentTypeLabel("README.markdown")).toBe("Document · MD");
    expect(documentTypeLabel("out/report.pdf")).toBe("Document · PDF");
    expect(documentTypeLabel("export.csv")).toBe("Table · CSV");
    expect(documentTypeLabel("site/index.html")).toBe("Page · HTML");
  });
});

describe("document paths", () => {
  it("shows a path inside the working directory relative to it", () => {
    expect(documentRelativePath(`${CWD}/docs/plan.md`, CWD)).toBe(
      "docs/plan.md",
    );
    expect(documentRelativePath(`${CWD}/README.md`, CWD)).toBe("README.md");
  });

  it("shortens a path outside the working directory to the home folder", () => {
    expect(documentRelativePath("/Users/ada/notes/todo.md", CWD)).toBe(
      "~/notes/todo.md",
    );
    expect(documentRelativePath("/tmp/report.md", CWD)).toBe("/tmp/report.md");
  });

  it("excludes dependency, VCS and build folders", () => {
    for (const relative of [
      "node_modules/pkg/README.md",
      ".git/COMMIT_EDITMSG.txt",
      "dist/index.html",
      "build/report.html",
      "target/doc/index.html",
      "packages/web/node_modules/pkg/CHANGELOG.md",
    ]) {
      expect(isExcludedDocumentPath(`${CWD}/${relative}`, CWD), relative).toBe(
        true,
      );
    }
  });

  it("keeps a project that itself lives under an excluded folder name", () => {
    const cwd = "/Users/ada/build/project";
    expect(isExcludedDocumentPath(`${cwd}/docs/plan.md`, cwd)).toBe(false);
    expect(isExcludedDocumentPath(`${cwd}/dist/plan.md`, cwd)).toBe(true);
  });

  it("excludes lockfiles and build manifests, not changelogs", () => {
    for (const name of [
      "Cargo.lock",
      "yarn.lock",
      "bun.lockb",
      "package-lock.json",
      "pnpm-lock.yaml",
      "requirements.txt",
      "requirements-dev.txt",
      "CMakeLists.txt",
    ]) {
      expect(isExcludedDocumentPath(`${CWD}/${name}`, CWD), name).toBe(true);
    }
    for (const name of ["CHANGELOG.md", "how-to-lock.md", "notes.txt"]) {
      expect(isExcludedDocumentPath(`${CWD}/${name}`, CWD), name).toBe(false);
    }
  });
});

describe("documents written by Claude Code", () => {
  it("cards a file created with Write", () => {
    const blocks = blocksFrom(
      "claude",
      claudeCall("w1", "Write", {
        file_path: `${CWD}/docs/plan.md`,
        content: "# Plan\n\nShip it.\n",
      }),
    );
    expect(collectTurnDocuments(blocks, { cwd: CWD })).toEqual([
      {
        path: `${CWD}/docs/plan.md`,
        name: "plan.md",
        relativePath: "docs/plan.md",
        extension: "md",
        typeLabel: "Document · MD",
      },
    ]);
  });

  it("leaves out a document that was only edited in place", () => {
    const blocks = blocksFrom(
      "claude",
      claudeCall("e1", "Edit", {
        file_path: `${CWD}/README.md`,
        old_string: "old title",
        new_string: "new title",
      }),
    );
    expect(paths(blocks)).toEqual([]);
    expect(paths(blocks, { includeEdits: true })).toEqual(["README.md"]);
  });

  it("cards a document that was written and then edited", () => {
    const blocks = blocksFrom("claude", [
      ...claudeCall("w1", "Write", {
        file_path: `${CWD}/docs/plan.md`,
        content: "# Plan\n",
      }),
      ...claudeCall("e1", "Edit", {
        file_path: `${CWD}/docs/plan.md`,
        old_string: "# Plan",
        new_string: "# The plan",
      }),
    ]);
    expect(paths(blocks)).toEqual(["docs/plan.md"]);
  });

  it("cards a document that was edited and then rewritten", () => {
    const blocks = blocksFrom("claude", [
      ...claudeCall("e1", "Edit", {
        file_path: `${CWD}/README.md`,
        old_string: "old",
        new_string: "new",
      }),
      ...claudeCall("w1", "Write", {
        file_path: `${CWD}/README.md`,
        content: "# Rewritten\n",
      }),
    ]);
    expect(paths(blocks)).toEqual(["README.md"]);
  });

  it("skips a write that failed", () => {
    const blocks = blocksFrom(
      "claude",
      claudeCall(
        "w1",
        "Write",
        { file_path: `${CWD}/docs/plan.md`, content: "# Plan\n" },
        "failed",
      ),
    );
    expect(paths(blocks)).toEqual([]);
  });

  it("skips a write the user denied", () => {
    const blocks = blocksFrom("claude", [
      ...claudeCall(
        "w1",
        "Write",
        { file_path: `${CWD}/docs/plan.md`, content: "# Plan\n" },
        "running",
      ),
      {
        type: "approval.requested",
        requestId: 7,
        title: "Write",
        kind: "edit",
        callId: "w1",
      },
      { type: "approval.resolved", requestId: 7, decision: "deny" },
    ]);
    expect(blocks[0].approval?.decided).toBe("deny");
    expect(paths(blocks)).toEqual([]);
  });

  it("waits for a pending approval", () => {
    const blocks = blocksFrom("claude", [
      ...claudeCall(
        "w1",
        "Write",
        { file_path: `${CWD}/docs/plan.md`, content: "# Plan\n" },
        "running",
      ),
      {
        type: "approval.requested",
        requestId: 7,
        title: "Write",
        kind: "edit",
        callId: "w1",
      },
    ]);
    expect(paths(blocks)).toEqual([]);
    expect(paths(blocks, { live: true })).toEqual([]);
  });

  it("cards an approved write once it completes", () => {
    const write = {
      file_path: `${CWD}/docs/plan.md`,
      content: "# Plan\n",
    };
    const approved: HarnessEvent[] = [
      ...claudeCall("w1", "Write", write, "running"),
      {
        type: "approval.requested",
        requestId: 7,
        title: "Write",
        kind: "edit",
        callId: "w1",
      },
      { type: "approval.resolved", requestId: 7, decision: "allow" },
    ];
    expect(paths(blocksFrom("claude", approved), { live: true })).toEqual([]);
    const done = blocksFrom("claude", [
      ...approved,
      ...claudeCall("w1", "Write", write).slice(1),
    ]);
    expect(paths(done, { live: true })).toEqual(["docs/plan.md"]);
  });

  it("shows only completed writes while the turn is live", () => {
    const blocks = blocksFrom("claude", [
      ...claudeCall("w1", "Write", {
        file_path: `${CWD}/docs/done.md`,
        content: "done\n",
      }),
      ...claudeCall(
        "w2",
        "Write",
        { file_path: `${CWD}/docs/pending.md`, content: "pending\n" },
        "running",
      ),
    ]);
    expect(paths(blocks, { live: true })).toEqual(["docs/done.md"]);
  });

  it("ignores source, data and excluded files", () => {
    const blocks = blocksFrom("claude", [
      ...claudeCall("w1", "Write", {
        file_path: `${CWD}/src/App.tsx`,
        content: "export {};\n",
      }),
      ...claudeCall("w2", "Write", {
        file_path: `${CWD}/data.json`,
        content: "{}\n",
      }),
      ...claudeCall("w3", "Write", {
        file_path: `${CWD}/node_modules/pkg/README.md`,
        content: "# pkg\n",
      }),
      ...claudeCall("w4", "Write", {
        file_path: `${CWD}/dist/index.html`,
        content: "<html></html>\n",
      }),
      ...claudeCall("w5", "Write", {
        file_path: `${CWD}/CHANGELOG.md`,
        content: "# Changelog\n",
      }),
      ...claudeCall("r1", "Read", { file_path: `${CWD}/docs/read.md` }),
      ...claudeCall("b1", "Bash", { command: "cat > notes.md <<EOF\nhi\nEOF" }),
    ]);
    expect(paths(blocks)).toEqual(["CHANGELOG.md"]);
  });

  it("cards a document written several times once", () => {
    const blocks = blocksFrom("claude", [
      ...claudeCall("w1", "Write", {
        file_path: `${CWD}/docs/plan.md`,
        content: "# Draft\n",
      }),
      ...claudeCall("w2", "Write", {
        file_path: `${CWD}/docs/other.md`,
        content: "# Other\n",
      }),
      ...claudeCall("w3", "Write", {
        file_path: "docs/plan.md",
        content: "# Final\n",
      }),
    ]);
    expect(paths(blocks)).toEqual(["docs/plan.md", "docs/other.md"]);
  });

  it("includes documents written by a delegated run", () => {
    const input = { file_path: `${CWD}/docs/research.md`, content: "# Notes" };
    const blocks = blocksFrom("claude", [
      {
        type: "tool.started",
        callId: "agent-1",
        title: "Research",
        kind: "agent",
        status: "in_progress",
      },
      {
        type: "agent.step",
        callId: "agent-1",
        stepId: "s1",
        kind: "tool",
        text: toolTitle("Write", input),
        toolKind: toolKindFromName("Write"),
        status: "completed",
        preview: previewFromTool("Write", input),
      },
      {
        type: "agent.step",
        callId: "agent-1",
        stepId: "s2",
        kind: "tool",
        text: "Write",
        toolKind: "edit",
        status: "failed",
        preview: previewFromTool("Write", {
          file_path: `${CWD}/docs/failed.md`,
          content: "x",
        }),
      },
    ]);
    expect(paths(blocks)).toEqual(["docs/research.md"]);
  });
});

describe("documents written by Codex", () => {
  it("cards a file an apply_patch added", () => {
    const blocks = blocksFrom(
      "codex",
      codexPatch("fc_1", [
        {
          path: `${CWD}/docs/report.md`,
          kind: "add",
          diff: "# Report\n\nAll good.\n",
        },
      ]),
    );
    expect(blocks[0].tool).toMatchObject({ kind: "edit", status: "completed" });
    expect(paths(blocks)).toEqual(["docs/report.md"]);
  });

  it("cards a file added as a unified diff from line one", () => {
    const blocks = blocksFrom(
      "codex",
      codexPatch("fc_1", [
        {
          path: "docs/report.md",
          kind: "add",
          diff: "@@ -0,0 +1,2 @@\n+# Report\n+All good.\n",
        },
      ]),
    );
    expect(paths(blocks)).toEqual(["docs/report.md"]);
  });

  it("leaves out an update to an existing document", () => {
    const blocks = blocksFrom(
      "codex",
      codexPatch("fc_1", [
        {
          path: `${CWD}/README.md`,
          kind: "update",
          diff: "@@ -1,2 +1,2 @@\n-# Old\n+# New\n intro\n",
        },
      ]),
    );
    expect(paths(blocks)).toEqual([]);
    expect(paths(blocks, { includeEdits: true })).toEqual(["README.md"]);
  });

  it("leaves out lines appended to an existing document", () => {
    const blocks = blocksFrom(
      "codex",
      codexPatch("fc_1", [
        {
          path: `${CWD}/CHANGELOG.md`,
          kind: "update",
          diff: "@@ -40,0 +41,2 @@\n+## 1.2.0\n+- Added cards\n",
        },
      ]),
    );
    expect(paths(blocks)).toEqual([]);
  });

  it("skips a patch that failed or was declined", () => {
    const change = {
      path: `${CWD}/docs/report.md`,
      kind: "add",
      diff: "# Report\n",
    };
    expect(
      paths(blocksFrom("codex", codexPatch("fc_1", [change], "failed"))),
    ).toEqual([]);
    expect(
      paths(blocksFrom("codex", codexPatch("fc_2", [change], "declined"))),
    ).toEqual([]);
  });

  it("skips a patch still in progress while the turn is live", () => {
    const events = codexPatch("fc_1", [
      { path: `${CWD}/docs/report.md`, kind: "add", diff: "# Report\n" },
    ]);
    const started = blocksFrom("codex", events.slice(0, 1));
    expect(paths(started, { live: true })).toEqual([]);
    expect(paths(blocksFrom("codex", events), { live: true })).toEqual([
      "docs/report.md",
    ]);
  });

  it("cannot tell a deletion from a new file by the transcript alone", () => {
    // Codex sends a deleted file's old contents where an added file's new
    // contents would be, and the stored block keeps neither change kind. The
    // card list withdraws it once it finds the file is not on disk.
    const blocks = blocksFrom(
      "codex",
      codexPatch("fc_1", [
        { path: `${CWD}/docs/old.md`, kind: "delete", diff: "# Old\n" },
      ]),
    );
    expect(paths(blocks)).toEqual(["docs/old.md"]);
  });

  it("sees only the first file of a multi-file patch", () => {
    // The stored block keeps one preview path; the event's `paths` list is
    // used for checkpoints and is not saved with the transcript.
    const blocks = blocksFrom(
      "codex",
      codexPatch("fc_1", [
        { path: `${CWD}/docs/a.md`, kind: "add", diff: "# A\n" },
        { path: `${CWD}/docs/b.md`, kind: "add", diff: "# B\n" },
      ]),
    );
    expect(paths(blocks)).toEqual(["docs/a.md"]);
  });
});

describe("documents written through an ACP harness", () => {
  /** One ACP edit tool call that reports its change as a diff block. */
  function acpEdit(
    callId: string,
    path: string,
    oldText: string | null,
    newText: string,
  ): HarnessEvent[] {
    const update = {
      toolCallId: callId,
      title: `Edit ${path}`,
      kind: "edit",
      status: "completed",
      locations: [{ path }],
      content: [{ type: "diff", path, oldText, newText }],
    };
    return [
      {
        type: "tool.started",
        callId,
        title: update.title,
        kind: "edit",
        status: "in_progress",
        preview: { kind: "write", path },
      },
      {
        type: "tool.updated",
        callId,
        title: update.title,
        kind: "edit",
        status: "completed",
        preview: extractToolPreview(update, {}),
      },
    ];
  }

  it("cards a file whose diff has no previous text", () => {
    const blocks = blocksFrom(
      "cursor",
      acpEdit("t1", `${CWD}/docs/guide.rst`, null, "Guide\n=====\n"),
    );
    expect(paths(blocks)).toEqual(["docs/guide.rst"]);
  });

  it("leaves out a file whose diff changes previous text", () => {
    const blocks = blocksFrom(
      "cursor",
      acpEdit(
        "t1",
        `${CWD}/docs/guide.rst`,
        "Guide\n=====\nOld body\n",
        "Guide\n=====\nNew body\n",
      ),
    );
    expect(paths(blocks)).toEqual([]);
    expect(paths(blocks, { includeEdits: true })).toEqual(["docs/guide.rst"]);
  });
});

describe("other write blocks", () => {
  function write(id: string, path: string, extra: Partial<Block> = {}): Block {
    return {
      id,
      role: "tool",
      text: `Write ${path}`,
      tool: {
        kind: "edit",
        title: `Write ${path}`,
        status: "completed",
        preview: { kind: "write", path, fileName: path.split("/").pop() },
      },
      ...extra,
    };
  }

  it("skips deletions and moves", () => {
    const blocks: Block[] = [
      {
        id: "d1",
        role: "tool",
        text: "Delete docs/old.md",
        tool: {
          kind: "delete",
          status: "completed",
          preview: { kind: "write", path: "docs/old.md" },
        },
      },
      {
        id: "d2",
        role: "tool",
        text: "Deleted docs/older.md",
        tool: {
          kind: "other",
          status: "completed",
          preview: { kind: "write", path: "docs/older.md" },
        },
      },
      {
        id: "m1",
        role: "tool",
        text: "Move docs/a.md",
        tool: {
          kind: "move",
          status: "completed",
          preview: { kind: "write", path: "docs/a.md" },
        },
      },
    ];
    expect(paths(blocks)).toEqual([]);
  });

  it("skips a cancelled write and one on another machine", () => {
    const blocks = [
      write("c1", "docs/cancelled.md", {
        tool: {
          kind: "edit",
          status: "cancelled",
          preview: { kind: "write", path: "docs/cancelled.md" },
        },
        approval: { requestId: 1, decided: "cancelled" },
      }),
      write("ok", "docs/kept.md"),
    ];
    expect(paths(blocks)).toEqual(["docs/kept.md"]);
    expect(
      collectTurnDocuments([write("r1", "docs/plan.md")], {
        cwd: "remote://box/Users/ada/project",
      }),
    ).toEqual([]);
  });

  it("needs a working directory to resolve a relative path", () => {
    expect(collectTurnDocuments([write("w1", "docs/plan.md")])).toEqual([]);
    expect(collectTurnDocuments([write("w2", "/tmp/plan.md")])).toMatchObject([
      { path: "/tmp/plan.md", relativePath: "/tmp/plan.md" },
    ]);
  });

  it("treats paths that differ only by spelling as one file", () => {
    const blocks = [
      write("w1", "docs/plan.md"),
      write("w2", `${CWD}/docs/plan.md`),
      write("w3", "./docs/plan.md"),
    ];
    expect(paths(blocks)).toEqual(["docs/plan.md"]);
  });

  it("keeps every document and leaves the cap to the list", () => {
    const blocks = Array.from({ length: 9 }, (_, index) =>
      write(`w${index}`, `docs/note-${index}.md`),
    );
    const files = collectTurnDocuments(blocks, { cwd: CWD });
    expect(files).toHaveLength(9);
    expect(MAX_DOCUMENT_CARDS).toBe(6);

    const folded = documentCardWindow(files, false);
    expect(folded.visible.map((file) => file.name)).toEqual([
      "note-0.md",
      "note-1.md",
      "note-2.md",
      "note-3.md",
      "note-4.md",
      "note-5.md",
    ]);
    expect(folded.hidden).toBe(3);

    const open = documentCardWindow(files, true);
    expect(open.visible).toHaveLength(9);
    expect(open.hidden).toBe(0);
  });

  it("shows no fold row at or under the cap", () => {
    const files = Array.from({ length: 6 }, (_, index) => index);
    expect(documentCardWindow(files, false)).toEqual({
      visible: files,
      hidden: 0,
    });
    expect(documentCardWindow([], false)).toEqual({ visible: [], hidden: 0 });
  });
});
