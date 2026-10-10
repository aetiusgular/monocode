// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionPanelSlot } from "../../session-panel";
import { SessionPane, type SessionPaneProps } from "./SessionPane";
import type { Session } from "../model/session";

const probes = vi.hoisted(() => ({
  mono: undefined as { id: string } | undefined,
  runs: [],
}));
vi.mock("./Composer", () => ({ Composer: () => null }));
vi.mock("../../monos/ui/MonoComposer", () => ({ MonoComposer: () => null }));
vi.mock("./AgentTranscript", () => ({ AgentTranscript: () => null }));
vi.mock("./SessionReview", () => ({ SessionReview: () => null }));
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
    probes.mono && {
      ...probes.mono,
      sessionId: "chat",
      name: "Captain",
      mascot: "cat",
      color: "#6ba",
      projects: [],
    },
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
  // happy-dom lays nothing out; give every box a wide pane's width.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 1200,
    height: 800,
  } as DOMRect);
  localStorage.clear();
  probes.mono = undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const noop = () => {};
function props(patch: Partial<Session> = {}): SessionPaneProps {
  return {
    session: {
      id: "chat",
      title: "Chat",
      cwd: "/repo",
      harness: "codex",
      model: "",
      modelSettings: {},
      runtimeMode: "supervised",
      blocks: [
        { id: "user", role: "user", text: "Hello" },
        {
          id: "tasks",
          role: "tasks",
          text: "",
          taskList: {
            items: [
              { text: "Inspect", status: "completed" },
              { text: "Implement", status: "in_progress" },
            ],
          },
        },
      ],
      ...patch,
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
}
function render(pane: SessionPaneProps) {
  act(() =>
    root.render(
      createElement(
        Fragment,
        null,
        // The window's title bar, cut down to the slot the button goes in.
        createElement("header", null, createElement(SessionPanelSlot)),
        createElement(SessionPane, pane),
      ),
    ),
  );
}
function showButton() {
  return container.querySelector<HTMLButtonElement>(
    '[aria-label="Show session panel"]',
  );
}
function panel() {
  return container.querySelector<HTMLElement>("aside[data-session-panel]");
}
function expectNoPanel() {
  expect(showButton()).toBeNull();
  expect(panel()).toBeNull();
}

it("opens a regular session's panel beside its transcript", () => {
  render(props());
  expect(panel()).toBeNull();
  act(() => showButton()!.click());
  expect(panel()?.textContent).toContain("1 earlier step");
  expect(panel()?.textContent).toContain("Implement");
  // A right column of the pane's row, not something inside the transcript.
  expect(panel()?.parentElement).toBe(
    container.querySelector("[data-session-drop]")?.lastElementChild,
  );
  expect(showButton()).toBeNull();

  act(() =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Close session panel"]')!
      .click(),
  );
  expect(panel()).toBeNull();
  expect(showButton()).not.toBeNull();
});

it("keeps the button off the chat: in the title bar, or a split pane's header", () => {
  const slot = () => container.querySelector("[data-session-panel-slot]");
  const pane = () => container.querySelector("[data-session-drop]");

  render(props());
  expect(showButton()?.parentElement).toBe(slot());
  expect(pane()?.contains(showButton())).toBe(false);

  // A pane in a split has a header of its own, and the title bar is shared.
  render({ ...props(), inSplit: true });
  expect(slot()?.childElementCount).toBe(0);
  expect(showButton()?.getAttribute("data-session-panel-toggle")).toBe(
    "pane-header",
  );
  expect(pane()?.firstElementChild?.contains(showButton())).toBe(true);

  // A parked tab stays mounted. It must not leave its button in the bar.
  render({ ...props(), visible: false, focused: false });
  expect(showButton()).toBeNull();
});

it("has no panel for a Mono's chat", () => {
  localStorage.setItem("monocode.sessionPanelOpen", "1");
  probes.mono = { id: "mono" };
  render(props());
  expectNoPanel();
});

it("has no panel for an orchestration worker", () => {
  localStorage.setItem("monocode.sessionPanelOpen", "1");
  render(props({ orchestrationLeadId: "lead" }));
  expectNoPanel();
});

it("has no panel for an Inbox conversation", () => {
  localStorage.setItem("monocode.sessionPanelOpen", "1");
  const inboxAsk = { key: "github:1" } as unknown as Session["inboxAsk"];
  render(props({ inboxAsk }));
  expectNoPanel();
});

it("has no panel for a session with nothing in it yet", () => {
  localStorage.setItem("monocode.sessionPanelOpen", "1");
  render(props({ blocks: [] }));
  expectNoPanel();
});

it("has no panel in a pane too narrow to push the transcript aside", () => {
  localStorage.setItem("monocode.sessionPanelOpen", "1");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 640,
    height: 800,
  } as DOMRect);
  render(props());
  expectNoPanel();
});
