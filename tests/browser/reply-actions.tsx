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

// A stand-in for the webview's voice. Headless Chromium has no voices, so the
// real engine would end every reading at once; this one reads until told to
// stop and keeps what it was asked to say.
const spoken: string[] = [];
const retried: number[] = [];
class FakeUtterance {
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly text: string) {}
}
const engine = {
  speaking: false,
  pending: false,
  speak(utterance: FakeUtterance) {
    spoken.push(utterance.text);
    engine.speaking = true;
  },
  cancel() {
    engine.speaking = false;
  },
};
Object.defineProperty(window, "speechSynthesis", {
  configurable: true,
  value: engine,
});
Object.defineProperty(window, "SpeechSynthesisUtterance", {
  configurable: true,
  value: FakeUtterance,
});
Object.assign(window, { spoken, retried });

const started = Date.UTC(2026, 9, 10, 9, 30);

// Two finished turns with every action the row can carry, so the two new
// buttons are measured in the most crowded row the app draws.
const blocks: Block[] = [
  {
    id: "user-1",
    role: "user",
    text: "Why does the build fail on CI?",
    startedAt: started,
    durationMs: 42_000,
    turnMetrics: {
      inputTokens: 18_400,
      outputTokens: 912,
      cacheReadTokens: 16_000,
      cacheHitPercent: 87,
    },
  },
  {
    id: "reply-1",
    role: "assistant",
    text: "The lockfile is **out of date**. Run this:\n\n```sh\nnpm install\n```\n\nThen push again.",
  },
  {
    id: "user-2",
    role: "user",
    text: "Do it.",
    startedAt: started + 60_000,
    durationMs: 9_000,
    turnMetrics: { inputTokens: 19_800, outputTokens: 120 },
  },
  {
    id: "reply-2",
    role: "assistant",
    text: "Done. The lockfile is updated and CI is green.",
  },
];

const width = Number(new URLSearchParams(location.search).get("width")) || 0;
const root = document.getElementById("root")!;
if (width) {
  root.style.width = `${width}px`;
  root.style.height = "100vh";
}

createRoot(root).render(
  <AgentTranscript
    blocks={blocks}
    harness="claude"
    onSaveNote={() => {}}
    onSecondOpinion={() => {}}
    onHandoff={() => {}}
    onEditLastTurn={() => {}}
    onRetryLastTurn={() => retried.push(Date.now())}
  />,
);
