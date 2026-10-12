// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Attachment,
  Block,
  ComposerTurnOptions,
  Session,
} from "../../sessions/model/session";
import {
  SessionPane,
  type SessionPaneProps,
} from "../../sessions/ui/SessionPane";
import {
  clearComposerDraft,
  getComposerDraft,
  setComposerDraft,
} from "../../sessions/model/draftCache";

type TranscriptProbe = {
  onEditLastTurn?: () => void;
  onRetryLastTurn?: () => void;
  retryingLastTurn?: boolean;
  resendingEdited?: boolean;
};
type ComposerProbe = {
  onEditingLastTurnChange?: (editing: boolean) => void;
  onRestorePromptReady?: (
    restore: (text: string, attachments: Attachment[]) => boolean,
  ) => void;
};

const probes = vi.hoisted(() => ({
  mono: false,
  runs: [],
  transcript: undefined as unknown,
  composer: undefined as unknown,
  restore: undefined as unknown,
}));
vi.mock("../../sessions/ui/Composer", () => ({
  Composer: (props: ComposerProbe) => {
    probes.composer = props;
    props.onRestorePromptReady?.(
      probes.restore as (text: string, attachments: Attachment[]) => boolean,
    );
    return null;
  },
}));
vi.mock("../../monos/ui/MonoComposer", () => ({ MonoComposer: () => null }));
vi.mock("../../sessions/ui/AgentTranscript", () => ({
  AgentTranscript: (props: TranscriptProbe) => {
    probes.transcript = props;
    return null;
  },
}));
vi.mock("../../sessions/ui/SessionReview", () => ({
  SessionReview: () => null,
  SessionChangesButton: () => null,
}));
vi.mock("../../orchestration/model/orchestration", async (original) => ({
  ...(await original<
    typeof import("../../orchestration/model/orchestration")
  >()),
  orchestrator: {
    subscribe: () => () => {},
    snapshot: () => probes.runs,
    hydrate: async () => {},
  },
}));
vi.mock("../../monos/model/mono", async (original) => ({
  ...(await original<typeof import("../../monos/model/mono")>()),
  monoForSession: () =>
    probes.mono
      ? {
          id: "mono",
          sessionId: "chat",
          name: "Captain",
          mascot: "cat",
          color: "#6ba",
          projects: [],
        }
      : undefined,
}));

let container: HTMLDivElement;
let root: Root;
let restore: ReturnType<
  typeof vi.fn<(text: string, attachments: Attachment[]) => boolean>
>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  localStorage.clear();
  clearComposerDraft("chat");
  clearComposerDraft("other");
  probes.mono = false;
  probes.transcript = undefined;
  probes.composer = undefined;
  restore = vi.fn(() => true);
  probes.restore = restore;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const photo: Attachment = {
  id: "photo",
  name: "shot.png",
  kind: "image",
  mimeType: "image/png",
  size: 4,
  path: "/tmp/shot.png",
};

const turn: Block[] = [
  { id: "u1", role: "user", text: "Earlier prompt", durationMs: 900 },
  { id: "a1", role: "assistant", text: "Earlier answer." },
  {
    id: "u2",
    role: "user",
    text: "Describe this screenshot",
    attachments: [photo],
    providerTurnId: "turn-2",
    durationMs: 1_200,
  },
  { id: "a2", role: "assistant", text: "It shows a login form." },
];

const noop = () => {};

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "chat",
    title: "Chat",
    cwd: "/repo",
    harness: "claude",
    model: "",
    modelSettings: {},
    runtimeMode: "supervised",
    blocks: turn,
    ...overrides,
  };
}

function pane(overrides: Partial<SessionPaneProps> = {}): SessionPaneProps {
  return {
    session: session(),
    visible: true,
    focused: true,
    inSplit: false,
    composerFocused: false,
    recents: [],
    onFocus: noop,
    onClose: noop,
    onCwdChange: noop,
    onBranchChange: noop,
    onWorkspaceModeChange: noop,
    onWorktreeBaseChange: noop,
    onModelChange: noop,
    onModelSettingsChange: noop,
    onRuntimeModeChange: noop,
    onSubmit: noop,
    onSaveDraft: noop,
    onRemoveDraft: noop,
    onStop: noop,
    onCompactContext: () => false,
    onPlaceSessionInFolder: noop,
    onDeleteQueuedMessage: noop,
    onEditQueuedMessage: noop,
    onQueuedMessageEditingChange: noop,
    onSteerQueuedMessage: noop,
    onResumeQueue: noop,
    onUsageLimitResume: noop,
    onUsageLimitResumeAtReset: noop,
    onUsageLimitDismiss: noop,
    onApproval: noop,
    onQuestionReply: noop,
    onOpenFile: noop,
    onOpenDiff: noop,
    onOpenPlan: noop,
    onBuildPlan: noop,
    onNewTerminal: noop,
    ...overrides,
  };
}

function render(props: SessionPaneProps) {
  act(() => root.render(createElement(SessionPane, props)));
}

const transcript = () => probes.transcript as TranscriptProbe;
const composer = () => probes.composer as ComposerProbe;

type Submit = (
  sessionId: string,
  text: string,
  attachments: Attachment[],
  options?: ComposerTurnOptions,
) => boolean | void;

describe("Retry in a session pane", () => {
  it("resends the last prompt with its files through edit and resend", () => {
    const onSubmit = vi.fn<Submit>(() => true);
    render(pane({ onSubmit }));
    expect(transcript().onEditLastTurn).toBeTypeOf("function");
    expect(transcript().onRetryLastTurn).toBeTypeOf("function");

    act(() => transcript().onRetryLastTurn!());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [sessionId, text, attachments, options] = onSubmit.mock.calls[0];
    expect(sessionId).toBe("chat");
    expect(text).toBe("Describe this screenshot");
    expect(attachments).toEqual([photo]);
    expect(options).toMatchObject({ intent: "default", resendEdited: true });
    expect(options?.onResendRejected).toBeTypeOf("function");
  });

  it("resends a plan turn as a plan turn", () => {
    const onSubmit = vi.fn<Submit>(() => true);
    const blocks = turn.map((block) =>
      block.id === "u2" ? { ...block, intent: "plan" as const } : block,
    );
    render(pane({ onSubmit, session: session({ blocks }) }));
    act(() => transcript().onRetryLastTurn!());
    expect(onSubmit.mock.calls[0][3]).toMatchObject({
      intent: "plan",
      resendEdited: true,
    });
  });

  it.each<[string, Partial<Session>]>([
    ["a harness that cannot take a turn back", { harness: "cursor" }],
    ["a running turn", { busy: true }],
    [
      "a Claude Code prompt whose place in the conversation is unknown",
      {
        blocks: turn.map(({ providerTurnId: _dropped, ...block }) => block),
      },
    ],
    [
      "a Codex prompt whose turn id is unknown",
      {
        harness: "codex",
        blocks: turn.map(({ providerTurnId: _dropped, ...block }) => block),
      },
    ],
    [
      "queued messages",
      { queuedMessages: [{ id: "q", text: "Next", attachments: [] }] },
    ],
  ])("is hidden with the pencil for %s", (_name, overrides) => {
    render(pane({ session: session(overrides) }));
    expect(transcript().onEditLastTurn).toBeUndefined();
    expect(transcript().onRetryLastTurn).toBeUndefined();
  });

  it("is hidden with the pencil in a Mono's chat and a host session", () => {
    probes.mono = true;
    render(pane());
    expect(transcript().onEditLastTurn).toBeUndefined();
    expect(transcript().onRetryLastTurn).toBeUndefined();

    probes.mono = false;
    // A host session is marked by a prop the pane keeps off its public type.
    render({ ...pane(), remoteSession: true } as SessionPaneProps);
    expect(transcript().onEditLastTurn).toBeUndefined();
    expect(transcript().onRetryLastTurn).toBeUndefined();
  });

  it("steps aside while the prompt is open for editing", () => {
    render(pane());
    act(() => composer().onEditingLastTurnChange!(true));
    expect(transcript().onEditLastTurn).toBeTypeOf("function");
    expect(transcript().onRetryLastTurn).toBeUndefined();
    act(() => composer().onEditingLastTurnChange!(false));
    expect(transcript().onRetryLastTurn).toBeTypeOf("function");
  });

  it("steps aside while a card or a draft turn would be caught up in it", () => {
    render(
      pane({
        session: session({
          noteCard: { id: "n", slug: "note", title: "Note", body: "Body" },
        }),
      }),
    );
    expect(transcript().onRetryLastTurn).toBeUndefined();

    render(
      pane({
        session: session({
          blocks: [
            ...turn,
            { id: "d", role: "user", text: "Unsent", draft: true },
          ],
        }),
      }),
    );
    expect(transcript().onRetryLastTurn).toBeUndefined();
  });

  it("labels the resend as a retry until the prompt is replaced", () => {
    const onSubmit = vi.fn<Submit>(() => true);
    const props = pane({ onSubmit });
    render(props);
    expect(transcript().retryingLastTurn).toBe(false);
    act(() => transcript().onRetryLastTurn!());

    // The app locks the session while the harness takes the turn back.
    render({
      ...props,
      session: session({ busy: true, resendingEdited: true }),
    });
    expect(transcript().resendingEdited).toBe(true);
    expect(transcript().retryingLastTurn).toBe(true);

    // The harness took the prompt: a new turn stands where the old one was.
    const replaced = [
      ...turn.slice(0, 2),
      { ...turn[2], id: "u3" },
      { id: "a3", role: "assistant" as const, text: "It shows a form." },
    ];
    render({ ...props, session: session({ blocks: replaced }) });
    expect(transcript().retryingLastTurn).toBe(false);

    // An edit of the new prompt is not a retry.
    render({
      ...props,
      session: session({
        blocks: replaced,
        busy: true,
        resendingEdited: true,
      }),
    });
    expect(transcript().retryingLastTurn).toBe(false);
  });

  it("does not call an edit and resend a retry", () => {
    const props = pane();
    render(props);
    render({
      ...props,
      session: session({ busy: true, resendingEdited: true }),
    });
    expect(transcript().resendingEdited).toBe(true);
    expect(transcript().retryingLastTurn).toBe(false);
  });

  it("is not a retry when the app refuses the resend", () => {
    const onSubmit = vi.fn<Submit>(() => false);
    const props = pane({ onSubmit });
    render(props);
    act(() => transcript().onRetryLastTurn!());
    render({
      ...props,
      session: session({ busy: true, resendingEdited: true }),
    });
    expect(transcript().retryingLastTurn).toBe(false);
  });

  it("leaves the turn in place when the harness could not take it back", () => {
    const onSubmit = vi.fn<Submit>(() => true);
    const props = pane({ onSubmit });
    render(props);
    act(() => transcript().onRetryLastTurn!());
    act(() =>
      onSubmit.mock.calls[0][3]!.onResendRejected!({ providerRewound: false }),
    );
    // Nothing was removed, so there is nothing to hand back to the composer.
    expect(restore).not.toHaveBeenCalled();
    expect(transcript().onRetryLastTurn).toBeTypeOf("function");
    // A later edit and resend of the same prompt is not labelled a retry.
    render({
      ...props,
      session: session({ busy: true, resendingEdited: true }),
    });
    expect(transcript().retryingLastTurn).toBe(false);
  });

  it("hands the prompt back to the composer when the turn was already gone", () => {
    const onSubmit = vi.fn<Submit>(() => true);
    render(pane({ onSubmit }));
    act(() => transcript().onRetryLastTurn!());
    act(() =>
      onSubmit.mock.calls[0][3]!.onResendRejected!({ providerRewound: true }),
    );
    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith("Describe this screenshot", [photo]);
  });

  it("keeps the prompt as the session's draft when the pane has moved on", () => {
    const onSubmit = vi.fn<Submit>(() => true);
    const props = pane({ onSubmit });
    render(props);
    act(() => transcript().onRetryLastTurn!());
    const reject = onSubmit.mock.calls[0][3]!.onResendRejected!;

    // The pane now shows another session, with its own composer.
    render({ ...props, session: session({ id: "other", blocks: [] }) });
    act(() => reject({ providerRewound: true }));
    expect(restore).not.toHaveBeenCalled();
    expect(getComposerDraft("chat")).toBe("Describe this screenshot");
    expect(getComposerDraft("other")).toBeUndefined();
  });

  it("does not replace a draft already waiting in the session it left", () => {
    const onSubmit = vi.fn<Submit>(() => true);
    const props = pane({ onSubmit });
    render(props);
    act(() => transcript().onRetryLastTurn!());
    const reject = onSubmit.mock.calls[0][3]!.onResendRejected!;

    act(() => root.unmount());
    root = createRoot(container);
    setComposerDraft("chat", "Half a thought");
    act(() => reject({ providerRewound: true }));
    expect(restore).not.toHaveBeenCalled();
    expect(getComposerDraft("chat")).toBe("Half a thought");
  });

  it("is not a retry when the app rejects it before submit returns", () => {
    const onSubmit = vi.fn<Submit>((_id, _text, _files, options) => {
      options?.onResendRejected?.({ providerRewound: false });
      return true;
    });
    const props = pane({ onSubmit });
    render(props);
    act(() => transcript().onRetryLastTurn!());
    render({
      ...props,
      session: session({ busy: true, resendingEdited: true }),
    });
    expect(transcript().retryingLastTurn).toBe(false);
  });
});
