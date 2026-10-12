// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const disk = new Map<string, string>();
const saves: Record<string, unknown>[] = [];
let conflict = false;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    const key = `${args.scope}:${args.project ?? ""}:${args.file}`;
    if (command === "project_context_read") {
      const text = store.get(key) ?? null;
      return { text, hash: `h:${text ?? ""}` };
    }
    if (command === "project_context_save") {
      saves.push(args);
      if (conflict) throw "conflict";
      store.set(key, String(args.text));
      return `h:${args.text}`;
    }
    throw new Error(command);
  }),
}));
vi.mock("../../../platform/tauri/fs", () => ({
  readTextFile: vi.fn(async (path: string) => {
    const text = disk.get(path);
    if (text == null) throw new Error("missing");
    return text;
  }),
}));
vi.mock("../../projects/ui/SearchableProjectPicker", () => ({
  SearchableProjectPicker: (props: {
    onSelectProject: (path: string) => void;
  }) =>
    createElement("button", {
      "data-pick": true,
      onClick: () => props.onSelectProject("/code/other"),
    }),
}));

import { InstructionsPage } from "./InstructionsPage";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  store.clear();
  disk.clear();
  saves.length = 0;
  conflict = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let index = 0; index < 5; index++)
    await act(async () => {
      await Promise.resolve();
    });
}

function area(id: string) {
  return container.querySelector(
    `[data-context-text="${id}"]`,
  ) as HTMLTextAreaElement;
}

function type(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("#27: the Instructions page", () => {
  it("loads and saves global instructions and private notes", async () => {
    store.set("global::instructions.md", "Be brief.");
    act(() =>
      root.render(createElement(InstructionsPage, { cwd: "/code/app" })),
    );
    await settle();
    expect(area("instructions-global").value).toBe("Be brief.");
    type(area("instructions-project"), "Staging is read only.");
    act(() =>
      (
        container.querySelector(
          '[data-context-save="instructions-project"]',
        ) as HTMLButtonElement
      ).click(),
    );
    await settle();
    expect(saves[0]).toMatchObject({
      scope: "project",
      project: "/code/app",
      file: "notes.md",
      text: "Staging is read only.",
      expectedHash: "h:",
    });
    expect(container.textContent).toContain("Saved.");
  });

  it("refuses to overwrite another window's save", async () => {
    act(() =>
      root.render(createElement(InstructionsPage, { cwd: "/code/app" })),
    );
    await settle();
    conflict = true;
    type(area("instructions-global"), "x");
    act(() =>
      (
        container.querySelector(
          '[data-context-save="instructions-global"]',
        ) as HTMLButtonElement
      ).click(),
    );
    await settle();
    expect(container.textContent).toContain("It changed in another window");
  });

  it("opens the project's AGENTS.md and switches the Claude Code setting", async () => {
    disk.set("/code/app/AGENTS.md", "# Agents");
    disk.set("/code/app/CLAUDE.md", "# Claude");
    const opened: string[] = [];
    act(() =>
      root.render(
        createElement(InstructionsPage, {
          cwd: "/code/app",
          onOpenFile: (path) => opened.push(path),
        }),
      ),
    );
    await settle();
    act(() =>
      (
        container.querySelector("[data-open-agents-md]") as HTMLButtonElement
      ).click(),
    );
    expect(opened).toEqual(["/code/app/AGENTS.md"]);
    expect(container.textContent).toContain("This project has a CLAUDE.md");
    const box = container.querySelector(
      "[data-agents-md-both]",
    ) as HTMLInputElement;
    expect(box.checked).toBe(true);
    act(() => box.click());
    expect(localStorage.getItem("monocode.agentsMdBesideClaudeMd")).toBe("off");
  });

  it("says when a project has no AGENTS.md, and lists harness files read only", async () => {
    disk.set("~/.claude/CLAUDE.md", "Global Claude rules");
    act(() =>
      root.render(createElement(InstructionsPage, { cwd: "/code/app" })),
    );
    await settle();
    expect(container.textContent).toContain("no AGENTS.md yet");
    expect(container.textContent).toContain("Global Claude rules");
    expect(container.textContent).toContain("~/.codex/AGENTS.md (none)");
  });

  it("switches project notes with the picker", async () => {
    store.set("project:/code/other:notes.md", "Other notes");
    act(() =>
      root.render(createElement(InstructionsPage, { cwd: "/code/app" })),
    );
    await settle();
    act(() =>
      (container.querySelector("[data-pick]") as HTMLButtonElement).click(),
    );
    await settle();
    expect(area("instructions-project").value).toBe("Other notes");
  });
});
