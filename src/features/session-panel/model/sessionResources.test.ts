import { describe, expect, it } from "vitest";
import { applyHarnessEvent } from "../../../integrations/harness/core/apply";
import {
  previewFromTool,
  toolKindFromName,
  toolTitle,
} from "../../../integrations/harness/providers/claude/claudeProtocol";
import {
  newSession,
  type Block,
  type Session,
} from "../../sessions/model/session";
import { collectTurnDocuments } from "../../file-cards/model/documentFiles";
import {
  outputTag,
  sessionAttachments,
  sessionFolders,
  sessionOutputs,
} from "./sessionResources";

const CWD = "/repo";

/** A turn in which the agent wrote each file whole. */
function turn(id: string, ...paths: string[]): Block[] {
  let state: Session = { ...newSession("claude", CWD), blocks: [] };
  paths.forEach((path, index) => {
    const input = { file_path: path, content: "text" };
    const callId = `${id}_${index}`;
    state = applyHarnessEvent(state, {
      type: "tool.started",
      callId,
      title: toolTitle("Write", input),
      kind: toolKindFromName("Write"),
      status: "pending",
      preview: previewFromTool("Write", input),
    });
    state = applyHarnessEvent(state, {
      type: "tool.updated",
      callId,
      title: toolTitle("Write", input),
      kind: toolKindFromName("Write"),
      status: "completed",
      preview: previewFromTool("Write", input, "ok"),
    });
  });
  return [{ id, role: "user", text: "Go on" }, ...state.blocks];
}

describe("sessionOutputs", () => {
  it("gathers the documents written across every turn, each once", () => {
    const blocks = [
      ...turn("t1", "/repo/docs/plan.md", "/repo/src/app.ts"),
      ...turn("t2", "/repo/docs/report.md", "/repo/docs/plan.md"),
    ];
    const outputs = sessionOutputs(blocks, { cwd: CWD });
    expect(outputs.map((file) => file.relativePath)).toEqual([
      "docs/plan.md",
      "docs/report.md",
    ]);
    expect(outputTag(outputs[0])).toBe("MD");
  });

  it("waits for a write in the running turn, not for one in a settled turn", () => {
    // A row some harnesses leave behind: the call ran, and never said so.
    const pending = (block: Block): Block =>
      block.tool
        ? { ...block, tool: { ...block.tool, status: undefined } }
        : block;
    const settled = turn("t1", "/repo/docs/plan.md").map(pending);
    const running = turn("t2", "/repo/docs/report.md").map(pending);
    const paths = (blocks: Block[], live: boolean) =>
      sessionOutputs(blocks, { cwd: CWD, live }).map(
        (file) => file.relativePath,
      );
    // Busy: the earlier turn is over, so its write landed whatever its row
    // says. The turn in hand has not reported its write done yet.
    expect(paths([...settled, ...running], true)).toEqual(["docs/plan.md"]);
    expect(paths([...settled, ...running], false)).toEqual([
      "docs/plan.md",
      "docs/report.md",
    ]);
  });

  it("does not let a message sent mid-turn end the turn it joined", () => {
    // A row some harnesses leave behind: the call ran, and never said so.
    const pending = (block: Block): Block =>
      block.tool
        ? { ...block, tool: { ...block.tool, status: undefined } }
        : block;
    const blocks: Block[] = [
      ...turn("t1", "/repo/docs/report.md").map(pending),
      { id: "steer", role: "user", text: "Also add a summary", sentAt: 10 },
    ];
    expect(sessionOutputs(blocks, { cwd: CWD, live: true })).toEqual([]);
  });

  it("counts a document edited in part once something writes it whole", () => {
    const edit = (id: string, path: string): Block[] => {
      const input = { file_path: path, old_string: "a", new_string: "b" };
      let state: Session = { ...newSession("claude", CWD), blocks: [] };
      for (const type of ["tool.started", "tool.updated"] as const) {
        state = applyHarnessEvent(state, {
          type,
          callId: id,
          title: toolTitle("Edit", input),
          kind: toolKindFromName("Edit"),
          status: type === "tool.started" ? "pending" : "completed",
          preview: previewFromTool("Edit", input, "ok"),
        });
      }
      return state.blocks;
    };
    const edited = edit("e1", "/repo/docs/plan.md");
    // Whatever the per-turn rule makes of a lone edit, the session agrees.
    expect(sessionOutputs(edited, { cwd: CWD })).toEqual(
      collectTurnDocuments(edited, { cwd: CWD }),
    );
    const both = [...edited, ...turn("t2", "/repo/docs/plan.md")];
    expect(
      sessionOutputs(both, { cwd: CWD }).map((file) => file.relativePath),
    ).toEqual(["docs/plan.md"]);
    expect(sessionOutputs(both, { cwd: CWD })).toEqual(
      collectTurnDocuments(both, { cwd: CWD }),
    );
  });

  it("reads each block once however often it is asked", () => {
    const blocks = [
      ...turn("t1", "/repo/docs/plan.md"),
      ...turn("t2", "/repo/docs/report.md"),
    ];
    const first = sessionOutputs(blocks, { cwd: CWD });
    // A streamed token replaces the last block and leaves the rest as they are.
    const next = [
      ...blocks,
      { id: "a", role: "assistant", text: "Done" } as Block,
    ];
    const second = sessionOutputs(next, { cwd: CWD });
    expect(second).toEqual(first);
    // Same objects: the earlier blocks' documents came from the cache.
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it("is empty for a session that wrote no document", () => {
    expect(
      sessionOutputs(turn("t1", "/repo/src/app.ts"), { cwd: CWD }),
    ).toEqual([]);
  });
});

describe("sessionAttachments", () => {
  it("lists what the user attached, with the message it came with", () => {
    const blocks: Block[] = [
      {
        id: "u1",
        role: "user",
        text: "See this",
        attachments: [
          {
            id: "a",
            name: "shot.png",
            mimeType: "image/png",
            kind: "image",
            size: 1,
          },
        ],
      },
      { id: "a1", role: "assistant", text: "Seen." },
      {
        id: "u2",
        role: "user",
        text: "And this",
        attachments: [
          {
            id: "a",
            name: "trace.log",
            mimeType: "text/plain",
            kind: "file",
            size: 1,
            path: "/tmp/trace.log",
          },
        ],
      },
    ];
    expect(sessionAttachments(blocks)).toEqual([
      { key: "u1:a", name: "shot.png", kind: "image", blockId: "u1" },
      {
        key: "u2:a",
        name: "trace.log",
        kind: "file",
        blockId: "u2",
        path: "/tmp/trace.log",
      },
    ]);
  });

  it("leaves out turns the app wrote on the user's behalf", () => {
    expect(
      sessionAttachments([
        {
          id: "u",
          role: "user",
          text: "",
          internal: true,
          attachments: [
            {
              id: "a",
              name: "x.png",
              mimeType: "image/png",
              kind: "image",
              size: 1,
            },
          ],
        },
      ]),
    ).toEqual([]);
  });
});

describe("sessionFolders", () => {
  it("puts the working folder first, then the folders added to it", () => {
    const folders = sessionFolders({
      cwd: "/work/app",
      extraDirs: ["/work/sdk", "/work/app", "/work/sdk/"],
    });
    expect(folders.map(({ name, role }) => [name, role])).toEqual([
      ["app", "working"],
      ["sdk", "added"],
    ]);
  });

  it("uses the worktree the session runs in rather than its project", () => {
    const folders = sessionFolders({
      cwd: "/work/app",
      worktreeCwd: "/work/trees/app-fix",
    });
    expect(folders).toHaveLength(1);
    expect(folders[0].path).toBe("/work/trees/app-fix");
    expect(folders[0].name).toBe("app-fix");
  });
});
