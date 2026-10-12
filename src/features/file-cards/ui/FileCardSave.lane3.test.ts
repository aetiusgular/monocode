// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DocumentFile } from "../model/documentFiles";
import { FileCard } from "./FileCard";

let container: HTMLDivElement;
let root: Root;

const file = {
  path: "/Users/ada/project/out/report.pdf",
  name: "report.pdf",
  relativePath: "out/report.pdf",
  typeLabel: "PDF",
} as DocumentFile;

beforeEach(() => {
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

function mount(onSave: (path: string) => Promise<never> | Promise<unknown>) {
  act(() =>
    root.render(
      createElement(FileCard, {
        file,
        onOpen: vi.fn(),
        onReveal: vi.fn(async () => undefined),
        onSave: onSave as never,
      }),
    ),
  );
  return container.querySelector<HTMLButtonElement>(
    'button[aria-label="Save a copy of report.pdf"]',
  )!;
}

it("saves a copy and says where it went", async () => {
  const onSave = vi.fn(async () => ({
    status: "saved" as const,
    path: "/Users/ada/Desktop/report.pdf",
  }));
  const button = mount(onSave);
  await act(async () => button.click());
  expect(onSave).toHaveBeenCalledWith(file.path);
  expect(container.textContent).toContain("Saved a copy to /Users/ada/Desktop/report.pdf");
});

it("shows nothing new when you cancel, and an error when it fails", async () => {
  const button = mount(async () => ({ status: "cancelled" }));
  await act(async () => button.click());
  expect(container.textContent).not.toContain("Saved");
  const failing = mount(async () => {
    throw new Error("disk full");
  });
  await act(async () => failing.click());
  expect(container.textContent).toContain("Couldn’t save a copy");
});
