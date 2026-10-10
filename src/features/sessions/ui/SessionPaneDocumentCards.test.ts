// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionPane, type SessionPaneProps } from "./SessionPane";

const probes = vi.hoisted(() => ({
  transcript: vi.fn(),
  mono: vi.fn(),
  runs: [],
}));
vi.mock("./Composer", () => ({ Composer: () => null }));
vi.mock("../hooks/useFileDrop", () => ({ useFileDrop: () => false }));
vi.mock("./AgentTranscript", () => ({
  AgentTranscript: (props: { documentCards?: boolean }) => {
    probes.transcript(props);
    return null;
  },
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
  monoForSession: probes.mono,
}));

let container: HTMLDivElement;
let root: Root;
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
  probes.transcript.mockClear();
  probes.mono.mockReset().mockReturnValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const noop = () => {};
function props(session: Partial<SessionPaneProps["session"]> = {}) {
  const pane: SessionPaneProps = {
    session: {
      id: "chat",
      title: "Chat",
      cwd: "/repo",
      harness: "codex",
      model: "",
      modelSettings: {},
      runtimeMode: "supervised",
      blocks: [{ id: "user", role: "user", text: "Hello" }],
      ...session,
    },
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
  };
  return pane;
}

function documentCards(pane: SessionPaneProps): boolean | undefined {
  probes.transcript.mockClear();
  act(() => root.render(createElement(SessionPane, pane)));
  expect(probes.transcript).toHaveBeenCalled();
  return probes.transcript.mock.lastCall![0].documentCards;
}

it("cards documents in a regular local session", () => {
  expect(documentCards(props())).toBe(true);
});

it("leaves document cards out of a Mono's chat", () => {
  probes.mono.mockReturnValue({
    id: "mono",
    sessionId: "chat",
    name: "Captain",
    mascot: "cat",
    color: "#6ba",
    projects: [],
  });
  expect(documentCards(props())).toBe(false);
});

it("leaves document cards out of an Inbox conversation", () => {
  expect(
    documentCards(
      props({
        inboxAsk: {
          key: "github:1",
          title: "Issue",
          url: "https://example.com/1",
          provider: "github",
        },
      }),
    ),
  ).toBe(false);
});

it("leaves document cards out of an orchestration worker", () => {
  expect(documentCards(props({ orchestrationLeadId: "lead" }))).toBe(false);
});

it("leaves document cards out of a session on another machine", () => {
  // RemoteSession renders this pane with the flag set; the files it names
  // are on the host, not on this computer.
  const remote = { ...props(), remoteSession: true } as SessionPaneProps;
  expect(documentCards(remote)).toBe(false);
});
