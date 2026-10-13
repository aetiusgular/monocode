// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 2.10: closing Settings lost what was typed in the Environment editor.

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "env_store_load") return { global: [], projects: {} };
    return null;
  }),
}));
vi.mock("../../projects/ui/SearchableProjectPicker", () => ({
  SearchableProjectPicker: () => createElement("span"),
}));

import { EnvironmentPage, __clearEnvDrafts } from "./EnvironmentPage";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  __clearEnvDrafts();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

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

async function open() {
  await act(async () =>
    root.render(createElement(EnvironmentPage, { cwd: "/code/my app" })),
  );
}

const field = (section: string, name: string) =>
  container.querySelector<HTMLInputElement>(`${section} [data-env-${name}]`)!;

describe("Environment drafts", () => {
  it("keeps typed values across closing and reopening Settings", async () => {
    await open();
    type(field("#setting-environment-global", "name"), "REGION");
    type(field("#setting-environment-global", "value"), "eu-west");
    type(field("#setting-environment-project", "name"), "-DASH");
    act(() => root.unmount());
    root = createRoot(container);
    await open();
    expect(field("#setting-environment-global", "name").value).toBe("REGION");
    expect(field("#setting-environment-global", "value").value).toBe("eu-west");
    expect(field("#setting-environment-project", "name").value).toBe("-DASH");
  });

  it("does not hold a secret's value after the page closes", async () => {
    await open();
    act(() => field("#setting-environment-global", "secret").click());
    type(field("#setting-environment-global", "name"), "API_TOKEN");
    type(field("#setting-environment-global", "value"), "s3cret");
    act(() => root.unmount());
    root = createRoot(container);
    await open();
    expect(field("#setting-environment-global", "name").value).toBe(
      "API_TOKEN",
    );
    expect(field("#setting-environment-global", "value").value).toBe("");
    expect(container.innerHTML).not.toContain("s3cret");
  });

  it("clears the draft once the value is Set", async () => {
    await open();
    type(field("#setting-environment-global", "name"), "REGION");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          "#setting-environment-global [data-env-add]",
        )!
        .click(),
    );
    act(() => root.unmount());
    root = createRoot(container);
    await open();
    expect(field("#setting-environment-global", "name").value).toBe("");
  });
});
