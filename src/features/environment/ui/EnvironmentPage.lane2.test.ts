// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Var = { name: string; secret: boolean; value: string | null };
let view: { global: Var[]; projects: Record<string, Var[]> };
const calls: { command: string; args: Record<string, unknown> }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "env_store_load") return structuredClone(view);
    if (command === "env_store_set") {
      const list = args.project
        ? (view.projects[String(args.project)] ??= [])
        : view.global;
      list.push({
        name: String(args.name),
        secret: args.secret === true,
        value: args.secret ? null : String(args.value),
      });
      return null;
    }
    if (command === "env_store_remove") {
      view.global = view.global.filter((v) => v.name !== args.name);
      return null;
    }
    throw new Error(command);
  }),
}));
vi.mock("../../projects/ui/SearchableProjectPicker", () => ({
  SearchableProjectPicker: () => createElement("span"),
}));

import { EnvironmentPage } from "./EnvironmentPage";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  view = { global: [], projects: {} };
  calls.length = 0;
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
  for (let index = 0; index < 6; index++)
    await act(async () => {
      await Promise.resolve();
    });
}

function type(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("#28: the Environment page", () => {
  it("never shows a secret's value", async () => {
    view.global = [
      { name: "REGION", secret: false, value: "eu" },
      { name: "DB_PASSWORD", secret: true, value: null },
    ];
    act(() =>
      root.render(createElement(EnvironmentPage, { cwd: "/code/app" })),
    );
    await settle();
    expect(container.textContent).toContain("eu");
    expect(
      container.querySelector('[data-env-var="DB_PASSWORD"]')?.textContent,
    ).toContain("in the keychain");
  });

  it("sets a project secret, masked while typed", async () => {
    act(() =>
      root.render(createElement(EnvironmentPage, { cwd: "/code/app" })),
    );
    await settle();
    const section = container.querySelector("#setting-environment-project")!;
    type(
      section.querySelector("[data-env-name]") as HTMLInputElement,
      "API_TOKEN",
    );
    act(() =>
      (section.querySelector("[data-env-secret]") as HTMLInputElement).click(),
    );
    const value = section.querySelector("[data-env-value]") as HTMLInputElement;
    expect(value.type).toBe("password");
    type(value, "s3cret");
    act(() =>
      (section.querySelector("[data-env-add]") as HTMLButtonElement).click(),
    );
    await settle();
    expect(
      calls.find((call) => call.command === "env_store_set")?.args,
    ).toEqual({
      project: "/code/app",
      name: "API_TOKEN",
      value: "s3cret",
      secret: true,
    });
    expect(container.textContent).not.toContain("s3cret");
  });

  it("refuses a reserved name before sending it", async () => {
    act(() =>
      root.render(createElement(EnvironmentPage, { cwd: "/code/app" })),
    );
    await settle();
    const section = container.querySelector("#setting-environment-global")!;
    type(
      section.querySelector("[data-env-name]") as HTMLInputElement,
      "ANTHROPIC_API_KEY",
    );
    expect(section.querySelector("[data-env-problem]")?.textContent).toContain(
      "Providers",
    );
    expect(
      (section.querySelector("[data-env-add]") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("removes a value and lists every harness", async () => {
    view.global = [{ name: "REGION", secret: false, value: "eu" }];
    act(() =>
      root.render(createElement(EnvironmentPage, { cwd: "/code/app" })),
    );
    await settle();
    act(() =>
      (
        container.querySelector("[data-env-remove]") as HTMLButtonElement
      ).click(),
    );
    await settle();
    expect(container.querySelector('[data-env-var="REGION"]')).toBeNull();
    expect(container.querySelector('[data-env-note="codex"]')).not.toBeNull();
    expect(container.querySelector('[data-env-note="claude"]')).not.toBeNull();
  });
});
