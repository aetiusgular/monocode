import { createRoot } from "react-dom/client";
import { AgentTranscript } from "../../src/features/sessions/ui/AgentTranscript";
import type { Block } from "../../src/features/sessions/model/session";
import {
  saveTranscriptAnchor,
  saveTranscriptLayout,
} from "../../src/features/settings/model/appearance";
import "../../src/styles/index.css";

saveTranscriptAnchor(false);
saveTranscriptLayout("chat");

const CWD = "/Users/ada/acme-app";

/** A whole-file write as Claude Code reports it: the path sits in the preview. */
function write(id: string, relative: string): Block {
  const path = `${CWD}/${relative}`;
  return {
    id,
    role: "tool",
    text: "Write",
    tool: {
      callId: id,
      title: "Write",
      kind: "edit",
      status: "completed",
      preview: {
        kind: "write",
        title: "Write",
        path,
        fileName: relative.split("/").pop(),
        contentOnly: true,
        lines: [{ number: 1, kind: "context", text: "# Draft" }],
      },
    },
  };
}

/** A patch as Codex reports it: the path sits in the label as well. */
function patch(id: string, relative: string, status = "completed"): Block {
  const path = `${CWD}/${relative}`;
  return {
    id,
    role: "tool",
    text: `Edit ${path}`,
    tool: {
      callId: id,
      title: `Edit ${path}`,
      kind: "edit",
      status,
      preview: {
        kind: "write",
        title: `Edit ${path}`,
        path,
        fileName: relative.split("/").pop(),
      },
    },
  };
}

// The first turn writes three documents among other work: a source file, a
// partial edit of an existing document and a failed write get no card. The
// second writes nine, which is past the cap.
const blocks: Block[] = [
  { id: "user-1", role: "user", text: "Write up the launch plan." },
  write("w-plan", "docs/launch-plan.md"),
  write("w-source", "src/launch/checklist.ts"),
  patch("p-metrics", "reports/q3-metrics.csv"),
  {
    id: "e-readme",
    role: "tool",
    text: "Edit",
    tool: {
      callId: "e-readme",
      title: "Edit",
      kind: "edit",
      status: "completed",
      preview: {
        kind: "write",
        path: `${CWD}/README.md`,
        fileName: "README.md",
        additions: 1,
        deletions: 1,
        lines: [
          { kind: "del", text: "# Acme" },
          { kind: "add", text: "# Acme App" },
        ],
      },
    },
  },
  patch("p-failed", "docs/rejected.md", "failed"),
  write("w-notes", "notes/2026-10-kickoff/meeting-notes.txt"),
  {
    id: "reply-1",
    role: "assistant",
    text: "The launch plan is in `docs/launch-plan.md`, with the metrics export and the kickoff notes beside it.",
  },
  { id: "user-2", role: "user", text: "Now split the research into notes." },
  ...Array.from({ length: 9 }, (_, index) =>
    write(`w-note-${index + 1}`, `docs/research/note-${index + 1}.md`),
  ),
  {
    id: "reply-2",
    role: "assistant",
    text: "Nine research notes are in `docs/research`.",
  },
];

const opened: string[] = [];
Object.assign(window, { openedFiles: opened });

createRoot(document.getElementById("root")!).render(
  <AgentTranscript
    blocks={blocks}
    cwd={CWD}
    harness="claude"
    documentCards
    onOpenFile={(path) => opened.push(path)}
  />,
);
