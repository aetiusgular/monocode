// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => ({
  read: vi.fn(),
  open: vi.fn(),
}));
vi.mock("../../../platform/tauri/fs", async (original) => ({
  ...(await original<typeof import("../../../platform/tauri/fs")>()),
  readBinaryFile: fs.read,
  openPathWithDefaultApp: fs.open,
}));
vi.mock("../model/fileWatch", () => ({ watchFile: () => () => undefined }));

import { MAX_PDF_PREVIEW_BYTES, PdfFileView } from "./PdfFileView";

let container: HTMLDivElement;
let root: Root;
let blobs: Blob[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  blobs = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    blobs.push(blob as Blob);
    return "blob:monocode/pdf-1";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  fs.read.mockReset();
  fs.open.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function show(path: string) {
  await act(async () => {
    root.render(createElement(PdfFileView, { path }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

it("shows a PDF in a frame on a blob typed application/pdf", async () => {
  fs.read.mockResolvedValue(new TextEncoder().encode("%PDF-1.7\n%%EOF"));
  await show("/Users/ada/project/my paper.pdf");
  const frame = container.querySelector("iframe");
  expect(frame?.getAttribute("src")).toBe("blob:monocode/pdf-1");
  expect(blobs[0].type).toBe("application/pdf");
  expect(container.textContent).toContain("Open in default app");
});

it("refuses markup named .pdf and offers the default app", async () => {
  fs.read.mockResolvedValue(new TextEncoder().encode("<script>x</script>"));
  await show("/p/fake.pdf");
  expect(container.querySelector("iframe")).toBeNull();
  expect(blobs).toHaveLength(0);
  expect(container.textContent).toContain("does not start like a PDF");
  const button = [...container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes("Open in default app"),
  );
  act(() => button?.click());
  expect(fs.open).toHaveBeenCalledWith("/p/fake.pdf");
});

it("does not copy a huge file into memory", async () => {
  const big = new Uint8Array(MAX_PDF_PREVIEW_BYTES + 1);
  big.set(new TextEncoder().encode("%PDF-1.7"));
  fs.read.mockResolvedValue(big);
  await show("/p/huge.pdf");
  expect(container.querySelector("iframe")).toBeNull();
  expect(container.textContent).toContain("too large");
});

it("reports a read error instead of hanging", async () => {
  fs.read.mockRejectedValue(new Error("Permission denied"));
  await show("/p/locked.pdf");
  expect(container.textContent).toContain("Permission denied");
});
