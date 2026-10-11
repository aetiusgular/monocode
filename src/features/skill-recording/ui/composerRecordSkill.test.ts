// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listSkills = vi.hoisted(() => vi.fn());
const listDir = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@tauri-apps/api/core")>();
  return {
    ...original,
    invoke: (command: string, args?: unknown) => {
      if (command === "list_skills") return listSkills(args);
      if (command === "list_dir") return listDir(args);
      if (command === "home_dir") return Promise.resolve("/home/tony");
      return original.invoke(command, args);
    },
  };
});
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("../../source-control/hooks/useProjectBranches", () => ({
  useProjectBranchesState: () => ({ branches: undefined, settled: true }),
}));
vi.mock("../../settings/model/sounds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../settings/model/sounds")>()),
  playCue: () => false,
}));

import type { DiscoveredSkill } from "../../../platform/tauri/fs";
import type { Block, HarnessId } from "../../sessions/model/session";
import { Composer } from "../../sessions/ui/Composer";
import {
  invalidateSkills,
  SKILLS_CHANGE_EVENT,
} from "../../skills/model/skills";
import { RECORD_SKILL_PROMPT_LEAD } from "../model/sessionOutline";

const CATALOG: DiscoveredSkill[] = [
  {
    name: "review-pr",
    description: "Review a pull request",
    path: "/repo/.claude/skills/review-pr/SKILL.md",
    scope: "project",
    source: "claude",
  },
];

const FINISHED: Block[] = [
  { id: "u1", role: "user", text: "Make the checkout test pass." },
  { id: "a1", role: "assistant", text: "Done." },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  invalidateSkills();
  listSkills.mockReset();
  listSkills.mockResolvedValue(CATALOG);
  listDir.mockReset();
  listDir.mockImplementation(({ path }: { path: string }) =>
    path === "/repo/.claude/skills"
      ? Promise.resolve([
          {
            name: "deploy",
            path: `${path}/deploy`,
            isDir: true,
            ignored: false,
          },
        ])
      : Promise.reject(new Error("not found")),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

type Options = {
  harness?: HarnessId;
  remoteSession?: boolean;
  busy?: boolean;
  skillRecording?: boolean;
  transcript?: Block[];
  onSubmit?: (text: string) => boolean | void;
};

async function renderComposer(options: Options = {}) {
  await act(async () =>
    root.render(
      createElement(Composer, {
        focused: true,
        harness: options.harness ?? "claude",
        model: "claude-sonnet",
        runtimeMode: "supervised",
        cwd: "/repo",
        executionCwd: "/repo",
        sessionId: "s1",
        hideProjectPicker: true,
        hideBranchPicker: true,
        remoteSession: options.remoteSession,
        busy: options.busy,
        skillRecording: options.skillRecording ?? true,
        transcript: options.transcript ?? FINISHED,
        onFocus: () => {},
        onCwdChange: () => {},
        onModelChange: () => {},
        onRuntimeModeChange: () => {},
        onSubmit: options.onSubmit ?? (() => {}),
      }),
    ),
  );
  await act(async () => {});
}

async function recordEntry() {
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Add files or choose a mode"]',
      )!
      .click(),
  );
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-composer-plus] button"),
  ).find((button) => button.textContent?.includes("Record a skill"));
}

const dialog = () =>
  document.querySelector<HTMLElement>(
    '[role="dialog"][aria-label="Record a skill"]',
  );

async function openDialog() {
  const entry = await recordEntry();
  await act(async () => entry!.click());
  await act(async () => {});
  return dialog()!;
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {});
}

const inputs = (surface: HTMLElement) =>
  Array.from(surface.querySelectorAll<HTMLInputElement>("input"));
const path = (surface: HTMLElement) =>
  surface.querySelector('[data-testid="record-skill-path"]')?.textContent;
const button = (surface: HTMLElement, label: string) =>
  Array.from(surface.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.includes(label),
  )!;

describe("Record a skill in the composer plus menu", () => {
  it.each(["claude", "codex"] as const)(
    "is offered on %s after a finished turn",
    async (harness) => {
      await renderComposer({ harness });
      const entry = await recordEntry();
      expect(entry?.disabled).toBe(false);
      expect(entry?.textContent).toContain(
        "Save what this chat did as a skill",
      );
    },
  );

  it.each(["cursor", "opencode", "pi", "grok"] as const)(
    "is not offered on %s",
    async (harness) => {
      await renderComposer({ harness });
      expect(await recordEntry()).toBeUndefined();
    },
  );

  it("is not offered before a turn finishes, remotely, or when the pane says no", async () => {
    await renderComposer({ transcript: [] });
    expect(await recordEntry()).toBeUndefined();
    await renderComposer({ transcript: [FINISHED[0]], busy: true });
    expect(await recordEntry()).toBeUndefined();
    await renderComposer({ remoteSession: true });
    expect(await recordEntry()).toBeUndefined();
    await renderComposer({ skillRecording: false });
    expect(await recordEntry()).toBeUndefined();
  });

  it("is disabled while a later turn runs", async () => {
    await renderComposer({
      transcript: [...FINISHED, { id: "u2", role: "user", text: "more" }],
      busy: true,
    });
    const entry = await recordEntry();
    expect(entry?.disabled).toBe(true);
    expect(entry?.textContent).toContain("Wait for this turn to finish");
  });
});

describe("Record a skill dialog", () => {
  it("shows the exact path for this project and for the user", async () => {
    await renderComposer();
    const surface = await openDialog();
    const [name] = inputs(surface);
    expect(document.activeElement).toBe(name);
    await type(name, "fix-checkout");
    expect(path(surface)).toBe("/repo/.claude/skills/fix-checkout/SKILL.md");
    await act(async () => button(surface, "Just me").click());
    await act(async () => {});
    expect(path(surface)).toBe(
      "/home/tony/.claude/skills/fix-checkout/SKILL.md",
    );
  });

  it("uses the Codex folders on Codex", async () => {
    await renderComposer({ harness: "codex" });
    const surface = await openDialog();
    await type(inputs(surface)[0], "fix-checkout");
    expect(path(surface)).toBe("/repo/.agents/skills/fix-checkout/SKILL.md");
  });

  it("refuses bad names and names that already exist", async () => {
    const onSubmit = vi.fn();
    await renderComposer({ onSubmit });
    const surface = await openDialog();
    const [name, description] = inputs(surface);
    await type(description, "Use when checkout tests fail.");

    await type(name, "Fix Checkout");
    expect(surface.textContent).toContain("Use lowercase letters");

    // A folder already in .claude/skills.
    await type(name, "deploy");
    expect(surface.textContent).toContain(
      "A skill named deploy already exists.",
    );

    // A skill already in the chat's catalog.
    await type(name, "review-pr");
    expect(surface.textContent).toContain(
      "A skill named review-pr already exists.",
    );

    await act(async () => button(surface, "Record").click());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
  });

  it("asks for the description before sending", async () => {
    const onSubmit = vi.fn();
    await renderComposer({ onSubmit });
    const surface = await openDialog();
    await type(inputs(surface)[0], "fix-checkout");
    await act(async () => button(surface, "Record").click());
    expect(surface.textContent).toContain("Say when the skill should be used.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("sends one turn with the prompt and closes", async () => {
    const onSubmit = vi.fn();
    await renderComposer({ onSubmit });
    const surface = await openDialog();
    const [name, description] = inputs(surface);
    await type(name, "fix-checkout");
    await type(description, "Use when checkout tests fail.");
    await act(async () => button(surface, "Record").click());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [text, attachments] = onSubmit.mock.calls[0];
    expect(attachments).toEqual([]);
    expect(text.startsWith(RECORD_SKILL_PROMPT_LEAD)).toBe(true);
    expect(text).toContain(
      "Write exactly one file: `/repo/.claude/skills/fix-checkout/SKILL.md`",
    );
    expect(text).toContain(
      "name: fix-checkout\ndescription: Use when checkout tests fail.",
    );
    expect(text).toContain("> 1. Make the checkout test pass.");
    expect(dialog()).toBeNull();
  });

  it("keeps the dialog open when the turn could not be sent", async () => {
    await renderComposer({ onSubmit: () => false });
    const surface = await openDialog();
    const [name, description] = inputs(surface);
    await type(name, "fix-checkout");
    await type(description, "Use when checkout tests fail.");
    await act(async () => button(surface, "Record").click());
    expect(dialog()).not.toBeNull();
    expect(surface.textContent).toContain("Could not send. Try again.");
  });

  it("refreshes the skill catalogs when the recording turn ends", async () => {
    const changes = vi.fn();
    window.addEventListener(SKILLS_CHANGE_EVENT, changes);
    try {
      await renderComposer();
      const surface = await openDialog();
      const [name, description] = inputs(surface);
      await type(name, "fix-checkout");
      await type(description, "Use when checkout tests fail.");
      await act(async () => button(surface, "Record").click());
      const sent: Block = { id: "u2", role: "user", text: "recording" };
      await renderComposer({ busy: true, transcript: [...FINISHED, sent] });
      expect(changes).not.toHaveBeenCalled();
      const loads = listSkills.mock.calls.length;
      await renderComposer({ busy: false, transcript: [...FINISHED, sent] });
      expect(changes).toHaveBeenCalledTimes(1);
      // The composer reads the catalog again from disk.
      expect(listSkills.mock.calls.length).toBeGreaterThan(loads);
    } finally {
      window.removeEventListener(SKILLS_CHANGE_EVENT, changes);
    }
  });
});
