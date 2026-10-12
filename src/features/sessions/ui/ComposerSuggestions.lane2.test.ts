// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Composer } from "./Composer";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

const prompts = [
  {
    id: "changes" as const,
    label: "Review 2 changed files",
    prompt: "Review the uncommitted changes in this folder.",
  },
];

async function mount(extra: Record<string, unknown>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onSubmit = vi.fn();
  const onDismiss = vi.fn();
  await act(async () =>
    root.render(
      createElement(Composer, {
        focused: false,
        harness: "codex",
        model: "",
        runtimeMode: "supervised",
        executionCwd: "~",
        hideTopBar: true,
        onFocus: vi.fn(),
        onCwdChange: vi.fn(),
        onModelChange: vi.fn(),
        onRuntimeModeChange: vi.fn(),
        onSubmit,
        suggestedPrompts: prompts,
        onDismissSuggestedPrompts: onDismiss,
        ...extra,
      }),
    ),
  );
  return {
    container,
    onSubmit,
    onDismiss,
    done: () => {
      act(() => root.unmount());
      container.remove();
      vi.restoreAllMocks();
    },
  };
}

it("fills the input from a chip and never sends it (#46)", async () => {
  const view = await mount({});
  try {
    const chip = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Review 2 changed files",
    )!;
    expect(chip).toBeTruthy();
    await act(async () => chip.click());
    const textarea = view.container.querySelector("textarea")!;
    expect(textarea.value).toBe(prompts[0]!.prompt);
    expect(view.onSubmit).not.toHaveBeenCalled();
    // With text in the input, the chips step aside.
    expect(view.container.querySelector("[data-suggested-prompts]")).toBeNull();
  } finally {
    view.done();
  }
});

it("shows no chips while a turn runs or over a draft the user wrote", async () => {
  for (const extra of [{ busy: true }, { initialDraft: "my own words" }]) {
    const view = await mount(extra);
    try {
      expect(
        view.container.querySelector("[data-suggested-prompts]"),
      ).toBeNull();
      expect(view.container.querySelector("textarea")!.value).toBe(
        "initialDraft" in extra ? "my own words" : "",
      );
    } finally {
      view.done();
    }
  }
});

it("hides them for the chat on close", async () => {
  const view = await mount({});
  try {
    const close = view.container.querySelector<HTMLButtonElement>(
      '[aria-label="Hide suggestions in this chat"]',
    )!;
    await act(async () => close.click());
    expect(view.onDismiss).toHaveBeenCalledOnce();
  } finally {
    view.done();
  }
});
