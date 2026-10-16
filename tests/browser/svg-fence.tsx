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

// Mac test 3.7: "Give me a fenced svg block of a red circle." A finished
// turn whose reply is that fence, as a local model writes it.
const started = Date.UTC(2026, 9, 15, 22, 30);
const blocks: Block[] = [
  {
    id: "user-1",
    role: "user",
    text: "Give me a fenced svg block of a red circle. Only the code block.",
    startedAt: started,
    durationMs: 12_000,
  },
  {
    id: "reply-1",
    role: "assistant",
    text: [
      "```svg",
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">',
      '  <circle cx="60" cy="60" r="50" fill="red" />',
      "</svg>",
      "```",
    ].join("\n"),
  },
];

createRoot(document.getElementById("root")!).render(
  <AgentTranscript
    blocks={blocks}
    harness="codex"
    onSaveNote={() => {}}
    onSecondOpinion={() => {}}
    onHandoff={() => {}}
    onEditLastTurn={() => {}}
  />,
);
