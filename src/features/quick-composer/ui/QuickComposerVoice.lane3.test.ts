// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

// #49: dictation in quick entry. The mic button sits in the toolbar, writes
// into the quick prompt, and is told to let go whenever the panel hides.

const native = vi.hoisted(() => ({
  focus: undefined as undefined | ((event: { payload: boolean }) => void),
  unlistened: 0,
}));
const voice = vi.hoisted(() => ({
  props: [] as Array<{
    textareaRef: { current: HTMLTextAreaElement | null };
    disabled?: boolean;
    releaseSignal?: number;
  }>,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: async (handler: (event: { payload: boolean }) => void) => {
      native.focus = handler;
      return () => {
        native.unlistened += 1;
      };
    },
    startDragging: async () => {},
  }),
}));
vi.mock("../../voice-input/ui/VoiceInputButton", () => ({
  VoiceInputButton: (props: (typeof voice.props)[number]) => {
    voice.props.push(props);
    return null;
  },
}));
vi.mock("./useQuickPickerMotion", () => ({ useQuickPickerMotion: () => {} }));
vi.mock("./QuickWorkspaceControls", () => ({
  QuickWorkspaceControls: () => null,
}));
vi.mock("./QuickProjectIcon", () => ({
  QuickProjectIcon: () => null,
  loadQuickProjectAppearance: () => ({}),
}));
vi.mock("./QuickModelSelector", () => ({ QuickModelSelector: () => null }));
vi.mock("./useQuickAttachments", () => ({
  useQuickAttachments: () => ({ files: [], clear: () => {} }),
}));
vi.mock("../model/quickComposer", async (actual) => ({
  ...(await actual<object>()),
  loadQuickProjects: () => ["/tmp/project"],
  initialQuickChoice: () => ({ harness: "codex", model: "test" }),
  resolveQuickModel: () => ({
    harness: "codex",
    id: "test",
    name: "Test model",
  }),
}));

import {
  QuickComposer,
  useReleaseOnHide,
  type HideSources,
} from "./QuickComposer";

let root: Root;
let container: HTMLDivElement;

const last = () => voice.props[voice.props.length - 1];

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    callback();
    return 0;
  });
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  voice.props = [];
  native.focus = undefined;
  native.unlistened = 0;
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () =>
    root.render(createElement(QuickComposer, { onShown: () => {} })),
  );
}

describe("QuickComposer dictation", () => {
  it("puts the mic on the quick prompt, enabled with a project open", async () => {
    await mount();
    const props = last();
    expect(props.textareaRef.current).toBe(container.querySelector("textarea"));
    expect(props.disabled).toBe(false);
    expect(props.releaseSignal).toBe(0);
  });

  it("tells the mic to let go when the native panel loses focus", async () => {
    await mount();
    expect(native.focus).toBeTypeOf("function");
    await act(async () => native.focus!({ payload: true }));
    expect(last().releaseSignal).toBe(0);
    await act(async () => native.focus!({ payload: false }));
    expect(last().releaseSignal).toBe(1);
  });

  it("tells the mic to let go on a webview blur or a hidden page", async () => {
    await mount();
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(last().releaseSignal).toBe(1);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    expect(last().releaseSignal).toBe(2);
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("tells the mic to let go when Escape dismisses the panel", async () => {
    await mount();
    const prompt = container.querySelector("textarea")!;
    await act(async () =>
      prompt.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(invoke).toHaveBeenCalledWith("quick_composer_dismiss");
    expect(last().releaseSignal).toBeGreaterThanOrEqual(1);
  });

  it("stops listening for focus when the panel unmounts", async () => {
    await mount();
    act(() => root.unmount());
    expect(native.unlistened).toBe(1);
    root = createRoot(container);
  });
});

describe("useReleaseOnHide", () => {
  it("keeps working when the native window cannot be reached", async () => {
    const seen: number[] = [];
    let domRelease: (() => void) | undefined;
    const sources: HideSources = {
      addDomListeners: (release) => {
        domRelease = release;
        return () => {};
      },
      onWindowBlur: async () => {
        throw new Error("no Tauri window");
      },
    };
    function Probe() {
      const [signal] = useReleaseOnHide(sources);
      seen.push(signal);
      return null;
    }
    await act(async () => root.render(createElement(Probe)));
    await act(async () => domRelease!());
    expect(seen[seen.length - 1]).toBe(1);
  });
});
