// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mac 6.18: a secret name typed as SECRET_Y was saved as ECRET_Y. Typed one
// key at a time here, in both scopes, with Secret on first and off, the
// name reaches Set whole. The page also turns off WebKit's text help on the
// name, which can replace a first letter under a controlled input.

const calls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "env_store_load") return { global: [], projects: {} };
    if (command === "env_store_set") calls.push(args);
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

const setter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "value",
)!.set!;

function typeKeys(element: HTMLInputElement, text: string) {
  for (const key of text) {
    act(() => {
      element.focus();
      setter.call(element, element.value + key);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
}

for (const section of ["global", "project"] as const) {
  for (const secretFirst of [true, false]) {
    it(`keeps every letter of a ${section} name, Secret ${secretFirst ? "first" : "after"}`, async () => {
      await act(async () =>
        root.render(
          createElement(EnvironmentPage, { cwd: "/Users/tony/my proj" }),
        ),
      );
      const field = (name: string) =>
        container.querySelector<HTMLInputElement>(
          `#setting-environment-${section} [data-env-${name}]`,
        )!;
      if (secretFirst) act(() => field("secret").click());
      typeKeys(field("name"), "SECRET_Y");
      if (!secretFirst) act(() => field("secret").click());
      typeKeys(field("value"), "s3cret");
      expect(field("name").value).toBe("SECRET_Y");
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            `#setting-environment-${section} [data-env-add]`,
          )!
          .click(),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ name: "SECRET_Y", secret: true });
    });
  }
}

describe("the name field", () => {
  it("has no autocorrect, autocapitalize, autocomplete or spellcheck", async () => {
    await act(async () =>
      root.render(createElement(EnvironmentPage, { cwd: "/code/-dash" })),
    );
    const name = container.querySelector<HTMLInputElement>("[data-env-name]")!;
    expect(name.getAttribute("autocorrect")).toBe("off");
    expect(name.getAttribute("autocapitalize")).toBe("off");
    expect(name.getAttribute("autocomplete")).toBe("off");
    expect(name.getAttribute("spellcheck")).toBe("false");
  });
});
