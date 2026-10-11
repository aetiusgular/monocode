// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../sessions/model/session";
import { AgentTranscript } from "../../sessions/ui/AgentTranscript";
import { currentSpeakingId, stopSpeaking } from "../model/speaker";

class FakeUtterance {
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly text: string) {}
}

function fakeEngine() {
  const engine = {
    speaking: false,
    pending: false,
    queued: [] as FakeUtterance[],
    speak: vi.fn((utterance: FakeUtterance) => {
      engine.queued.push(utterance);
      engine.speaking = true;
    }),
    cancel: vi.fn(() => {
      engine.queued = [];
      engine.speaking = false;
    }),
  };
  return engine;
}

let container: HTMLDivElement;
let root: Root;
let engine: ReturnType<typeof fakeEngine>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  engine = fakeEngine();
  vi.stubGlobal("speechSynthesis", engine);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  stopSpeaking();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Two finished turns. The second is the one edit and resend would reach.
const blocks: Block[] = [
  { id: "u1", role: "user", text: "First prompt", durationMs: 1_000 },
  { id: "a1", role: "assistant", text: "First **answer**." },
  { id: "u2", role: "user", text: "Second prompt", durationMs: 2_000 },
  { id: "t2", role: "tool", text: "npm test" },
  {
    id: "a2",
    role: "assistant",
    text: "Second answer.\n\n```sh\nnpm test\n```\n\nAll green.",
  },
];

type TranscriptProps = Parameters<typeof AgentTranscript>[0];

function render(props: Partial<TranscriptProps> = {}) {
  act(() => root.render(createElement(AgentTranscript, { blocks, ...props })));
}

function turnRow(turnId: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(
    `[data-transcript-turn="${turnId}"] [data-turn-actions]`,
  );
  if (!row) throw new Error(`no action row under turn ${turnId}`);
  return row;
}

function button(row: ParentNode, label: string) {
  return row.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

describe("Retry under a reply", () => {
  it("sits beside copy under the last reply of an idle session only", () => {
    const onRetryLastTurn = vi.fn();
    render({ onRetryLastTurn });

    expect(container.querySelectorAll('[aria-label="Retry"]')).toHaveLength(1);
    const last = turnRow("u2");
    const retry = button(last, "Retry")!;
    expect(retry.type).toBe("button");
    expect(retry.title).toBe("Retry");
    // Same group as the copy button, so the row reads as one set.
    expect(retry.parentElement).toBe(
      button(last, "Copy response")!.parentElement,
    );
    expect(button(turnRow("u1"), "Retry")).toBeNull();

    act(() => retry.click());
    expect(onRetryLastTurn).toHaveBeenCalledTimes(1);
  });

  it("is absent where edit and resend is absent", () => {
    render();
    expect(container.querySelector('[aria-label="Retry"]')).toBeNull();
  });

  it("is absent while a turn is running", () => {
    render({ onRetryLastTurn: vi.fn(), busy: true });
    expect(container.querySelector('[aria-label="Retry"]')).toBeNull();
  });

  it("stays with the last sent turn when an unsent draft follows it", () => {
    const withDraft: Block[] = [
      ...blocks,
      { id: "d", role: "user", text: "Not sent yet", draft: true },
    ];
    render({ blocks: withDraft, onRetryLastTurn: vi.fn() });
    // The draft is a turn of its own with nothing to redo. (The pane goes
    // further and withholds Retry while a draft is there.)
    expect(container.querySelectorAll('[aria-label="Retry"]')).toHaveLength(1);
    expect(button(turnRow("u2"), "Retry")).not.toBeNull();
  });

  it("says it is retrying while the same prompt is on its way back", () => {
    render({ busy: true, resendingEdited: true, retryingLastTurn: true });
    const line = container.querySelector("[data-live-resending]");
    expect(line?.textContent).toBe("Retrying…");

    render({ busy: true, resendingEdited: true });
    expect(container.querySelector("[data-live-resending]")?.textContent).toBe(
      "Sending the edited prompt…",
    );
  });
});

describe("Read aloud under a reply", () => {
  it("is offered under every finished reply", () => {
    render();
    expect(button(turnRow("u1"), "Read aloud")).not.toBeNull();
    expect(button(turnRow("u2"), "Read aloud")).not.toBeNull();
  });

  it("speaks the reply's prose and turns into Stop", () => {
    render();
    const read = button(turnRow("u2"), "Read aloud")!;
    act(() => read.click());

    expect(engine.queued.map((utterance) => utterance.text)).toEqual([
      "Second answer.",
      "Code block.",
      "All green.",
    ]);
    expect(currentSpeakingId()).toBe("u2");
    expect(read.getAttribute("aria-label")).toBe("Stop reading");
    expect(read.title).toBe("Stop reading");
    expect(read.getAttribute("aria-pressed")).toBe("true");
    // The other reply still offers to read.
    expect(button(turnRow("u1"), "Read aloud")).not.toBeNull();

    act(() => read.click());
    expect(engine.cancel).toHaveBeenCalledTimes(1);
    expect(currentSpeakingId()).toBeNull();
    expect(read.getAttribute("aria-label")).toBe("Read aloud");
    expect(read.getAttribute("aria-pressed")).toBe("false");
  });

  it("goes back to Read aloud when the voice reaches the end", () => {
    render();
    const read = button(turnRow("u1"), "Read aloud")!;
    act(() => read.click());
    expect(engine.queued.map((utterance) => utterance.text)).toEqual([
      "First answer.",
    ]);
    act(() => engine.queued[0].onend?.());
    expect(read.getAttribute("aria-label")).toBe("Read aloud");
  });

  it("reads one reply at a time", () => {
    vi.useFakeTimers();
    render();
    const first = button(turnRow("u1"), "Read aloud")!;
    const second = button(turnRow("u2"), "Read aloud")!;
    act(() => first.click());
    act(() => second.click());
    expect(first.getAttribute("aria-label")).toBe("Read aloud");
    expect(second.getAttribute("aria-label")).toBe("Stop reading");
    expect(
      container.querySelectorAll('[aria-label="Stop reading"]'),
    ).toHaveLength(1);
  });

  it("stops when the transcript is hidden, as on a switch of session", () => {
    render();
    act(() => button(turnRow("u1"), "Read aloud")!.click());
    expect(currentSpeakingId()).toBe("u1");
    render({ visible: false });
    expect(currentSpeakingId()).toBeNull();
    expect(engine.cancel).toHaveBeenCalled();
  });

  it("stops when the transcript is parked", () => {
    render();
    act(() => button(turnRow("u1"), "Read aloud")!.click());
    render({ parked: true });
    expect(currentSpeakingId()).toBeNull();
  });

  it("stops when the reply goes away", () => {
    render();
    act(() => button(turnRow("u2"), "Read aloud")!.click());
    act(() => root.unmount());
    expect(currentSpeakingId()).toBeNull();
    expect(engine.cancel).toHaveBeenCalled();
    root = createRoot(container);
  });

  it("stops when its reply is retried", () => {
    render({ onRetryLastTurn: vi.fn() });
    act(() => button(turnRow("u2"), "Read aloud")!.click());
    // The retry makes the turn live again, which takes its action row away.
    render({ busy: true, resendingEdited: true, retryingLastTurn: true });
    expect(currentSpeakingId()).toBeNull();
  });

  it("is hidden where the webview cannot speak", () => {
    vi.stubGlobal("speechSynthesis", undefined);
    render({ onRetryLastTurn: vi.fn() });
    expect(container.querySelector('[aria-label="Read aloud"]')).toBeNull();
    // Retry does not depend on a voice.
    expect(button(turnRow("u2"), "Retry")).not.toBeNull();
  });

  it("is hidden under a turn with nothing to say", () => {
    const silent: Block[] = [
      { id: "u", role: "user", text: "Run it", durationMs: 500 },
      { id: "t", role: "tool", text: "npm test" },
      { id: "k", role: "tasks", text: "- [x] Run the tests" },
    ];
    render({ blocks: silent });
    expect(container.querySelector("[data-turn-actions]")).not.toBeNull();
    expect(container.querySelector('[aria-label="Read aloud"]')).toBeNull();
  });
});
