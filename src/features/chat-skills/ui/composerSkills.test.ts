// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listSkills = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@tauri-apps/api/core")>();
  return {
    ...original,
    invoke: (command: string, args?: unknown) =>
      command === "list_skills"
        ? listSkills(args)
        : original.invoke(command, args),
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
import type { HarnessId } from "../../sessions/model/session";
import { Composer } from "../../sessions/ui/Composer";
import { invalidateSkills } from "../../skills/model/skills";
import { OPEN_SKILLS_SETTINGS_EVENT } from "../model/chatSkills";

const skill = (
  name: string,
  description: string,
  source: DiscoveredSkill["source"] = "claude",
): DiscoveredSkill => ({
  name,
  description,
  path: `/repo/.${source}/skills/${name}/SKILL.md`,
  scope: "project",
  source,
});

const CATALOG = [
  skill("review-pr", "Review a pull request"),
  skill("deploy", "Ship the current branch to staging"),
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  invalidateSkills();
  listSkills.mockReset();
  listSkills.mockResolvedValue(CATALOG);
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
  compact?: boolean;
  disabledSkills?: string[];
  onDisabledSkillsChange?: (names: string[]) => void;
  initialDraft?: string;
};

async function renderComposer(options: Options) {
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
        compact: options.compact,
        disabledSkills: options.disabledSkills,
        onDisabledSkillsChange: options.onDisabledSkillsChange,
        initialDraft: options.initialDraft,
        onFocus: () => {},
        onCwdChange: () => {},
        onModelChange: () => {},
        onRuntimeModeChange: () => {},
        onSubmit: () => {},
      }),
    ),
  );
  // The catalog loads on a later tick.
  await act(async () => {});
}

async function plusMenuEntry() {
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Add files or choose a mode"]',
      )!
      .click(),
  );
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-composer-plus] button"),
  ).find((button) => button.textContent?.includes("Skills"));
}

const popover = () =>
  document.querySelector<HTMLElement>('[role="dialog"][aria-label="Skills"]');

async function openSkills() {
  const entry = await plusMenuEntry();
  await act(async () => entry!.click());
  await act(async () => {});
  return popover()!;
}

function rows(surface: HTMLElement) {
  return Array.from(surface.querySelectorAll("li")).map((row) => {
    const [name, detail] = Array.from(row.querySelectorAll("span > span")).map(
      (part) => part.textContent,
    );
    const toggle = row.querySelector<HTMLButtonElement>('[role="switch"]')!;
    return {
      name,
      detail,
      on: toggle.getAttribute("aria-checked") === "true",
      label: toggle.getAttribute("aria-label"),
    };
  });
}

const toggle = (surface: HTMLElement, name: string) =>
  surface.querySelector<HTMLButtonElement>(
    `[role="switch"][aria-label="${name}"]`,
  )!;

/** The names the `/` list offers once a slash is typed. */
async function slashOptions() {
  const textarea = container.querySelector("textarea")!;
  await act(async () =>
    textarea.dispatchEvent(new Event("input", { bubbles: true })),
  );
  await act(async () => {});
  return Array.from(
    container.querySelectorAll('[data-skill-picker] [role="option"]'),
  ).map((option) => option.textContent ?? "");
}

const offers = (options: string[], name: string) =>
  options.some((text) => text.includes(`/${name}`));

describe("Skills in the composer plus menu", () => {
  it.each(["claude", "codex", "cursor", "opencode"] as const)(
    "is offered for %s",
    async (harness) => {
      await renderComposer({ harness, onDisabledSkillsChange: vi.fn() });
      expect((await plusMenuEntry())?.textContent).toContain(
        "Turn skills off for this chat",
      );
    },
  );

  it.each(["pi", "omp"] as const)(
    "is not offered for %s, which runs its own commands",
    async (harness) => {
      await renderComposer({ harness, onDisabledSkillsChange: vi.fn() });
      expect(await plusMenuEntry()).toBeUndefined();
    },
  );

  it("is not offered for a host session or without a change handler", async () => {
    await renderComposer({
      remoteSession: true,
      onDisabledSkillsChange: vi.fn(),
    });
    expect(await plusMenuEntry()).toBeUndefined();
    await renderComposer({});
    expect(await plusMenuEntry()).toBeUndefined();
  });

  it("shows how many skills are off on the menu entry", async () => {
    await renderComposer({
      disabledSkills: ["deploy", "review-pr"],
      onDisabledSkillsChange: vi.fn(),
    });
    expect((await plusMenuEntry())?.textContent).toContain("2 off");
  });
});

describe("Skills popover", () => {
  it("lists the chat's skills with their state for this chat", async () => {
    await renderComposer({
      disabledSkills: ["deploy"],
      onDisabledSkillsChange: vi.fn(),
    });
    const surface = await openSkills();
    expect(listSkills).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(rows(surface)).toEqual([
      // MonoCode's own skill is part of every catalog.
      expect.objectContaining({ name: "/create-skill", on: true }),
      {
        name: "/deploy",
        detail: "Ship the current branch to staging",
        on: false,
        label: "deploy",
      },
      {
        name: "/review-pr",
        detail: "Review a pull request",
        on: true,
        label: "review-pr",
      },
    ]);
    // Opening the switches replaces the plus menu.
    expect(document.body.textContent).not.toContain("Upload file");
    expect(
      Array.from(surface.querySelectorAll("button")).every(
        (button) => button.type === "button",
      ),
    ).toBe(true);
  });

  it("reads the catalog again when it opens", async () => {
    await renderComposer({ onDisabledSkillsChange: vi.fn() });
    const before = listSkills.mock.calls.length;
    listSkills.mockResolvedValue([...CATALOG, skill("triage", "Sort issues")]);
    const surface = await openSkills();
    expect(listSkills.mock.calls.length).toBeGreaterThan(before);
    expect(rows(surface).map((row) => row.name)).toContain("/triage");
  });

  it("switches a skill off and back on for this chat", async () => {
    const onDisabledSkillsChange = vi.fn();
    await renderComposer({ onDisabledSkillsChange });
    let surface = await openSkills();
    await act(async () => toggle(surface, "deploy").click());
    expect(onDisabledSkillsChange).toHaveBeenLastCalledWith(["deploy"]);

    await renderComposer({
      disabledSkills: ["deploy"],
      onDisabledSkillsChange,
    });
    surface = popover()!;
    expect(rows(surface).find((row) => row.label === "deploy")?.on).toBe(false);
    await act(async () => toggle(surface, "review-pr").click());
    expect(onDisabledSkillsChange).toHaveBeenLastCalledWith([
      "deploy",
      "review-pr",
    ]);
    await act(async () => toggle(surface, "deploy").click());
    expect(onDisabledSkillsChange).toHaveBeenLastCalledWith([]);
    // The app-wide list in Settings is never written.
    expect(localStorage.getItem("monocode.disabledSkillPaths")).toBeNull();
  });

  it("keeps a switched-off skill that is gone from the project, to switch back on", async () => {
    const onDisabledSkillsChange = vi.fn();
    await renderComposer({
      disabledSkills: ["old-skill"],
      onDisabledSkillsChange,
    });
    const surface = await openSkills();
    expect(rows(surface).at(-1)).toEqual({
      name: "/old-skill",
      detail: "Not found in this project",
      on: false,
      label: "old-skill",
    });
    await act(async () => toggle(surface, "old-skill").click());
    expect(onDisabledSkillsChange).toHaveBeenLastCalledWith([]);
  });

  it("says what Off covers, once a skill is off", async () => {
    const claude =
      "Off also stops Claude Code from using the skill on its own.";
    await renderComposer({ onDisabledSkillsChange: vi.fn() });
    expect((await openSkills()).textContent).not.toContain(claude);
    await renderComposer({
      disabledSkills: ["deploy"],
      onDisabledSkillsChange: vi.fn(),
    });
    expect(popover()!.textContent).toContain(claude);
  });

  it("says on Codex that the harness may still load the skill itself", async () => {
    await renderComposer({
      harness: "codex",
      disabledSkills: ["deploy"],
      onDisabledSkillsChange: vi.fn(),
    });
    const surface = await openSkills();
    expect(surface.textContent).toContain(
      "Off covers this chat's / menu. Codex may still load the skill on its own.",
    );
    expect(surface.textContent).not.toContain("stops Claude Code");
  });

  it("says Claude Code follows from the next turn when changed mid-turn", async () => {
    const note = "Claude Code follows from the next turn.";
    await renderComposer({ busy: true, onDisabledSkillsChange: vi.fn() });
    expect((await openSkills()).textContent).not.toContain(note);
    await renderComposer({
      busy: true,
      disabledSkills: ["deploy"],
      onDisabledSkillsChange: vi.fn(),
    });
    expect(popover()!.textContent).toContain(note);
    // Idle again: the next turn starts with the switch.
    await renderComposer({
      disabledSkills: ["deploy"],
      onDisabledSkillsChange: vi.fn(),
    });
    expect(popover()!.textContent).not.toContain(note);
  });

  it("has no such note on Codex, where nothing waits for a turn", async () => {
    await renderComposer({
      harness: "codex",
      busy: true,
      onDisabledSkillsChange: vi.fn(),
    });
    await openSkills();
    await renderComposer({
      harness: "codex",
      busy: true,
      disabledSkills: ["deploy"],
      onDisabledSkillsChange: vi.fn(),
    });
    expect(popover()!.textContent).not.toContain("from the next turn");
  });

  it("opens Settings on the Skills page from Manage skills", async () => {
    const opened = vi.fn();
    window.addEventListener(OPEN_SKILLS_SETTINGS_EVENT, opened);
    await renderComposer({ onDisabledSkillsChange: vi.fn() });
    const surface = await openSkills();
    const manage = Array.from(surface.querySelectorAll("button")).find(
      (button) => button.textContent === "Manage skills",
    )!;
    await act(async () => manage.click());
    expect(opened).toHaveBeenCalledTimes(1);
    expect(popover()).toBeNull();
    window.removeEventListener(OPEN_SKILLS_SETTINGS_EVENT, opened);
  });

  it("still lists MonoCode's own skill when the project has none", async () => {
    listSkills.mockResolvedValue([]);
    await renderComposer({ onDisabledSkillsChange: vi.fn() });
    const surface = await openSkills();
    expect(rows(surface).map((row) => row.name)).toEqual(["/create-skill"]);
  });

  it("closes on Escape and on a click outside", async () => {
    await renderComposer({ onDisabledSkillsChange: vi.fn() });
    await openSkills();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(popover()).toBeNull();
    await openSkills();
    await act(async () => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(popover()).toBeNull();
  });
});

describe("the / list of a chat with a skill switched off", () => {
  it("offers every skill while none is off", async () => {
    await renderComposer({
      initialDraft: "/",
      onDisabledSkillsChange: vi.fn(),
    });
    const options = await slashOptions();
    expect(offers(options, "deploy")).toBe(true);
    expect(offers(options, "review-pr")).toBe(true);
  });

  it("leaves the switched-off skill out and keeps the rest", async () => {
    await renderComposer({
      initialDraft: "/",
      disabledSkills: ["deploy"],
      onDisabledSkillsChange: vi.fn(),
    });
    const options = await slashOptions();
    expect(offers(options, "deploy")).toBe(false);
    expect(offers(options, "review-pr")).toBe(true);
    // The app's own commands are not skills and stay.
    expect(offers(options, "plan")).toBe(true);
  });

  it("does not mark a switched-off skill's /name as a skill in the draft", async () => {
    const marked = () =>
      Array.from(container.querySelectorAll(".text-skill")).map(
        (token) => token.textContent,
      );
    await renderComposer({
      initialDraft: "/deploy now",
      onDisabledSkillsChange: vi.fn(),
    });
    await slashOptions();
    expect(marked()).toEqual(["/deploy"]);
    await renderComposer({
      initialDraft: "/deploy now",
      disabledSkills: ["deploy"],
      onDisabledSkillsChange: vi.fn(),
    });
    await slashOptions();
    expect(marked()).toEqual([]);
  });

  it("ignores the list on a harness that has no switches", async () => {
    // A chat moved to Pi keeps its list, but there is no control there to
    // change it, so it must not hide anything either.
    await renderComposer({
      harness: "pi",
      initialDraft: "/",
      disabledSkills: ["deploy"],
      onDisabledSkillsChange: vi.fn(),
    });
    expect(offers(await slashOptions(), "deploy")).toBe(true);
  });
});

describe("switched-off skills in a compact composer", () => {
  it("adds the count to the summary", async () => {
    await renderComposer({
      compact: true,
      disabledSkills: ["deploy"],
      onDisabledSkillsChange: vi.fn(),
    });
    const summary = container.querySelector<HTMLElement>(
      "[data-session-tools-summary]",
    );
    expect(summary?.textContent).toBe("1 skill off");
    expect(summary?.title).toBe("Skills off: deploy");
  });
});
