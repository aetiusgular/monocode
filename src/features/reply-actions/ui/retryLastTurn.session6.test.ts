// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block, Session } from "../../sessions/model/session";
import { useRetryLastTurn, type RetryLastTurn } from "./useRetryLastTurn";

// Mac 11.T2.8: after Retry the status line read "Sonnet 5 working for 1s",
// not "Retrying…". The label went away the moment the harness took the
// prompt, before the retried turn had put out anything.

const turn: Block[] = [
  { id: "u1", role: "user", text: "Earlier prompt" },
  { id: "a1", role: "assistant", text: "Earlier answer." },
  { id: "u2", role: "user", text: "what is 2+2", providerTurnId: "uuid-x" },
  { id: "a2", role: "assistant", text: "4" },
];

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "chat",
    title: "Chat",
    cwd: "/Users/tony/my proj",
    harness: "claude",
    model: "",
    modelSettings: {},
    runtimeMode: "supervised",
    blocks: turn,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let latest: RetryLastTurn | undefined;
const submit = vi.fn(() => true);

function Probe({ value }: { value: Session }) {
  latest = useRetryLastTurn({
    session: value,
    recall: { text: "what is 2+2", attachments: [] },
    submit,
  });
  return null;
}

const render = (value: Session) =>
  act(() => root.render(createElement(Probe, { value })));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  latest = undefined;
  submit.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the Retry label", () => {
  it("stays on the retried turn until its first output", () => {
    render(session());
    act(() => latest!.retry!());
    render(session({ busy: true, resendingEdited: true }));
    expect(latest!.retrying).toBe(true);

    // The harness took the prompt; nothing has come back yet.
    const taken = [...turn.slice(0, 2), { ...turn[2], id: "u3" }];
    render(session({ blocks: taken, busy: true }));
    expect(latest!.retrying).toBe(true);
    render(session({ blocks: taken, busy: true }));
    expect(latest!.retrying).toBe(true);

    // First output: the line is the turn's own again.
    const answered = [
      ...taken,
      { id: "a3", role: "assistant" as const, text: "4" },
    ];
    render(session({ blocks: answered, busy: true }));
    expect(latest!.retrying).toBe(false);
  });

  it("is off once the retried turn ends without output", () => {
    render(session());
    act(() => latest!.retry!());
    render(session({ busy: true, resendingEdited: true }));
    const taken = [...turn.slice(0, 2), { ...turn[2], id: "u3" }];
    render(session({ blocks: taken, busy: true }));
    render(session({ blocks: taken, busy: false }));
    expect(latest!.retrying).toBe(false);
  });

  it("does not label a later prompt as a retry", () => {
    render(session());
    act(() => latest!.retry!());
    render(session({ busy: true, resendingEdited: true }));
    const answered = [
      ...turn.slice(0, 2),
      { ...turn[2], id: "u3" },
      { id: "a3", role: "assistant" as const, text: "4" },
    ];
    render(session({ blocks: answered, busy: false }));
    const next = [
      ...answered,
      { id: "u4", role: "user" as const, text: "and 3+3" },
    ];
    render(session({ blocks: next, busy: true }));
    expect(latest!.retrying).toBe(false);
  });

  it("is not on for a turn sent without Retry", () => {
    const next = [...turn, { id: "u4", role: "user" as const, text: "next" }];
    render(session({ blocks: next, busy: true }));
    expect(latest!.retrying).toBe(false);
  });
});
