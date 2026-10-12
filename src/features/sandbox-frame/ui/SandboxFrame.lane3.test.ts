// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn(
    (path: string, protocol: string) => `${protocol}://localhost/${path}`,
  ),
}));
vi.mock("@tauri-apps/api/core", () => tauri);

import { SandboxFrame } from "./SandboxFrame";

const TOKEN = "0123456789abcdef0123456789abcdef";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  tauri.invoke.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();
  });
}

it("loads the document on the scheme in a scripts-only sandbox", async () => {
  tauri.invoke.mockImplementation(async (command: string) =>
    command === "sandbox_frame_put" ? TOKEN : undefined,
  );
  act(() =>
    root.render(
      createElement(SandboxFrame, {
        html: "<p>hi</p><script>document.body.dataset.ran='1'</script>",
        title: "report.html",
        mode: "scripts",
      }),
    ),
  );
  await settle();
  const frame = container.querySelector("iframe");
  expect(frame?.getAttribute("src")).toBe(`mcpreview://localhost/${TOKEN}`);
  expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
  expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
  const [, args] = tauri.invoke.mock.calls[0];
  expect(args.html).toMatch(/^<meta http-equiv="Content-Security-Policy"/);
  expect(args.html).toContain("<script>");
});

it("releases the document when the frame goes away", async () => {
  tauri.invoke.mockImplementation(async (command: string) =>
    command === "sandbox_frame_put" ? TOKEN : undefined,
  );
  act(() =>
    root.render(
      createElement(SandboxFrame, { html: "<p>a</p>", title: "a", mode: "scripts" }),
    ),
  );
  await settle();
  act(() => root.render(createElement("div")));
  expect(tauri.invoke).toHaveBeenCalledWith("sandbox_frame_release", {
    token: TOKEN,
  });
});

it("falls back to a script-free frame when the store is unreachable", async () => {
  tauri.invoke.mockRejectedValue(new Error("no tauri"));
  act(() =>
    root.render(
      createElement(SandboxFrame, { html: "<p>a</p>", title: "a", mode: "scripts" }),
    ),
  );
  await settle();
  const frame = container.querySelector("iframe");
  expect(frame?.getAttribute("sandbox")).toBe("");
  expect(frame?.hasAttribute("src")).toBe(false);
  expect(container.textContent).toContain("Scripts are off");
});

it("static mode never calls the store and runs no script", async () => {
  act(() =>
    root.render(
      createElement(SandboxFrame, { html: "<p>a</p>", title: "a", mode: "static" }),
    ),
  );
  await settle();
  expect(tauri.invoke).not.toHaveBeenCalled();
  expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
});

it("refuses a document larger than the store holds", async () => {
  act(() =>
    root.render(
      createElement(SandboxFrame, {
        html: "x".repeat(10 * 1024 * 1024 + 1),
        title: "big",
        mode: "scripts",
      }),
    ),
  );
  await settle();
  expect(tauri.invoke).not.toHaveBeenCalled();
  expect(container.querySelector("iframe")).toBeNull();
  expect(container.textContent).toContain("larger than the preview holds");
});

it("debounces rapid edits into one store call", async () => {
  tauri.invoke.mockImplementation(async (command: string) =>
    command === "sandbox_frame_put" ? TOKEN : undefined,
  );
  for (const html of ["<p>1</p>", "<p>12</p>", "<p>123</p>"]) {
    act(() =>
      root.render(createElement(SandboxFrame, { html, title: "d", mode: "scripts" })),
    );
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
  }
  await settle();
  const puts = tauri.invoke.mock.calls.filter(
    ([command]) => command === "sandbox_frame_put",
  );
  expect(puts).toHaveLength(1);
  expect(puts[0][1].html).toContain("<p>123</p>");
});
