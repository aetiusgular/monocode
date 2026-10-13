// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessPicker } from "./AccessPicker";
import type { RuntimeMode } from "../model/session";

// 5.8: a set Codex permissions profile could not be cleared without emptying
// the field first, and Full access hid a profile it was ignoring.

let container: HTMLDivElement;
let root: Root;
const onProfileChange = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onProfileChange.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function openMenu(value: RuntimeMode, profile?: string) {
  await act(async () =>
    root.render(
      createElement(AccessPicker, {
        value,
        onChange: () => {},
        profile,
        onProfileChange,
      }),
    ),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>("[data-access-picker-trigger]")!
      .click(),
  );
}

const q = <T extends Element>(selector: string) =>
  document.querySelector<T>(selector);

function type(value: string) {
  const input = q<HTMLInputElement>(
    'input[aria-label="Codex permissions profile"]',
  )!;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AccessPicker permissions profile", () => {
  it("shows a set profile with Clear always available", async () => {
    await openMenu("supervised", "s7test");
    expect(q("[data-access-profile]")?.textContent).toContain("s7test");
    // The field starts empty and Use waits for typed text.
    expect(
      q<HTMLInputElement>('input[aria-label="Codex permissions profile"]')!
        .value,
    ).toBe("");
    expect(q<HTMLButtonElement>("[data-access-profile-use]")!.disabled).toBe(
      true,
    );
    await act(async () =>
      q<HTMLButtonElement>("[data-access-profile-clear]")!.click(),
    );
    expect(onProfileChange).toHaveBeenCalledWith("");
  });

  it("Use applies the typed text", async () => {
    await openMenu("supervised", "s7test");
    type("  net-npm ");
    expect(q("[data-access-profile-clear]")).not.toBeNull();
    await act(async () =>
      q<HTMLButtonElement>("[data-access-profile-use]")!.click(),
    );
    expect(onProfileChange).toHaveBeenCalledWith("net-npm");
  });

  it("an empty submit does not clear the profile", async () => {
    await openMenu("supervised", "s7test");
    await act(async () =>
      q<HTMLFormElement>("[data-access-profile-use]")!
        .closest("form")!
        .requestSubmit(),
    );
    expect(onProfileChange).not.toHaveBeenCalled();
  });

  it("offers no Clear when no profile is set", async () => {
    await openMenu("supervised");
    expect(q("[data-access-profile]")).toBeNull();
    expect(q("[data-access-profile-clear]")).toBeNull();
  });

  it("says Full access ignores the profile instead of hiding it", async () => {
    await openMenu("full-access", "s7test");
    expect(q("[data-access-profile-ignored]")?.textContent).toBe(
      "Full access ignores the profile s7test.",
    );
    expect(q("[data-access-profile]")).not.toBeNull();
  });

  it("has no ignored note outside Full access", async () => {
    await openMenu("auto-accept-edits", "s7test");
    expect(q("[data-access-profile-ignored]")).toBeNull();
  });
});
