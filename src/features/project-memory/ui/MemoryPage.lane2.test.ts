// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    const key = `${args.project ?? ""}:${args.file}`;
    if (command === "project_context_read") {
      const text = store.get(key) ?? null;
      return { text, hash: `h:${text ?? ""}` };
    }
    if (command === "project_context_save") {
      store.set(key, String(args.text));
      return `h:${args.text}`;
    }
    throw new Error(command);
  }),
}));
vi.mock("../../projects/ui/SearchableProjectPicker", () => ({
  SearchableProjectPicker: () => createElement("span"),
}));

import { MemoryPage } from "./MemoryPage";

let container: HTMLDivElement;
let root: Root;
const project = "/code/app";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  store.clear();
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
  for (let index = 0; index < 8; index++)
    await act(async () => {
      await Promise.resolve();
    });
}

function click(selector: string) {
  act(() => (container.querySelector(selector) as HTMLElement).click());
}

describe("#36: the Memory page", () => {
  it("lists live entries, marks local ones, and removes one", async () => {
    store.set(
      `${project}:MEMORY.md`,
      "- 2026-10-01 · Uses pnpm\n- ~~2026-09-01 · Uses npm~~ · superseded 2026-10-01\n- 2026-10-02 · [local] Client is United\n",
    );
    act(() => root.render(createElement(MemoryPage, { cwd: project })));
    await settle();
    const rows = container.querySelectorAll("[data-memory-entry]");
    expect(rows).toHaveLength(2);
    expect(container.textContent).not.toContain("Uses npm");
    expect(rows[1].textContent).toContain("Local only");
    click('[data-memory-entry="0"] [data-memory-remove]');
    await settle();
    expect(store.get(`${project}:MEMORY.md`)).not.toContain("Uses pnpm");
  });

  it("adds an entry, local only when ticked", async () => {
    act(() => root.render(createElement(MemoryPage, { cwd: project })));
    await settle();
    expect(container.textContent).toContain("Nothing remembered yet.");
    const input = container.querySelector(
      "[data-memory-draft]",
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(input, "Staging is read only");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click("[data-memory-draft-local]");
    click("[data-memory-add]");
    await settle();
    expect(store.get(`${project}:MEMORY.md`)).toMatch(
      /· \[local\] Staging is read only/,
    );
  });

  it("accepts and dismisses what agents proposed", async () => {
    store.set(
      `${project}:proposals.json`,
      JSON.stringify([
        {
          id: "p1",
          fact: "CI runs on push",
          local: false,
          source: "agent",
          at: 1,
        },
        {
          id: "p2",
          fact: "Wrong guess",
          local: true,
          source: "suggested",
          at: 2,
        },
      ]),
    );
    act(() => root.render(createElement(MemoryPage, { cwd: project })));
    await settle();
    expect(container.textContent).toContain("from an agent");
    expect(container.textContent).toContain("suggested, local only");
    click('[data-memory-proposal="p1"] [data-proposal-accept]');
    await settle();
    click('[data-memory-proposal="p2"] [data-proposal-reject]');
    await settle();
    expect(store.get(`${project}:MEMORY.md`)).toContain("CI runs on push");
    expect(store.get(`${project}:MEMORY.md`)).not.toContain("Wrong guess");
    expect(JSON.parse(store.get(`${project}:proposals.json`) ?? "[]")).toEqual(
      [],
    );
  });
});
