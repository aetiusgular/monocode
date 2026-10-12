// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPreview } from "../model/previewStore";
import type { PreviewCandidate } from "../model/launchConfig";
import { previewFingerprint } from "../model/launchConfig";
import { recordPreviewConfirmed } from "../model/confirmations";
import { AppPreviewView, PREVIEW_FRAME_SANDBOX } from "./AppPreviewPane";
import { PreviewChoices } from "./PreviewServerSection";
import { VerifyCardView } from "../../verify/ui/VerifyCard";
import { evaluateVerify } from "../../verify/model/verify";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  // happy-dom would fetch the frame's page; the tests read attributes only.
  const happy = (window as unknown as {
    happyDOM?: { settings: { disableIframePageLoading: boolean } };
  }).happyDOM;
  if (happy) happy.settings.disableIframePageLoading = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(element: ReturnType<typeof createElement>) {
  act(() => root.render(element));
}

const candidate: PreviewCandidate = {
  key: "script:dev",
  label: "npm run dev",
  source: "package.json",
  program: "npm",
  args: ["run", "dev"],
  cwd: "",
  env: {},
  autoPort: false,
  scriptBody: "vite --port 5173",
};

const preview = (patch: Partial<AppPreview> = {}): AppPreview => ({
  sessionId: "s1",
  project: "/p",
  workCwd: "/p",
  runCwd: "/p",
  processId: "p1",
  candidate,
  fingerprint: previewFingerprint(candidate),
  command: "npm run dev",
  url: "http://localhost:5173/",
  status: "ready",
  httpStatus: 200,
  frame: { blocked: false },
  startedAt: 0,
  ...patch,
});

describe("the preview pane", () => {
  it("frames a ready server in a sandbox that cannot move the app's window", () => {
    render(createElement(AppPreviewView, { preview: preview() }));
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("http://localhost:5173/");
    const sandbox = frame.getAttribute("sandbox")!;
    expect(sandbox).toBe(PREVIEW_FRAME_SANDBOX);
    for (const token of ["allow-modals", "allow-popups", "allow-top-navigation", "allow-downloads"])
      expect(PREVIEW_FRAME_SANDBOX).not.toContain(token);
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("shows no frame before the server answers, or after it stops", () => {
    for (const status of ["starting", "waiting", "stopped", "failed"] as const) {
      render(createElement(AppPreviewView, { preview: preview({ status }) }));
      expect(container.querySelector("iframe"), status).toBeNull();
      expect(container.querySelector("[data-app-preview-message]")?.textContent).toBeTruthy();
    }
    render(createElement(AppPreviewView, { preview: undefined }));
    expect(container.textContent).toContain("Start one from the session panel");
  });

  it("offers the browser for a page that refuses framing", () => {
    render(
      createElement(AppPreviewView, {
        preview: preview({ frame: { blocked: true, reason: "X-Frame-Options: DENY" } }),
      }),
    );
    expect(container.querySelector("iframe")).toBeNull();
    const banner = container.querySelector("[data-app-preview-blocked]")!;
    expect(banner.textContent).toContain("X-Frame-Options: DENY");
    expect(banner.textContent).toContain("Open in browser");
  });

  it("never frames an address that is not this machine", () => {
    render(
      createElement(AppPreviewView, {
        preview: preview({ url: "http://localhost:@evil.example/" }),
      }),
    );
    expect(container.querySelector("iframe")).toBeNull();
  });
});

describe("the confirmation", () => {
  function choices(picked: PreviewCandidate | null, list = [candidate]) {
    const calls = { confirm: [] as PreviewCandidate[], cancel: 0 };
    render(
      createElement(PreviewChoices, {
        project: "/p",
        choices: { candidates: list, problems: ["Configuration 2 is not an object"] },
        picked,
        busy: false,
        onPick: () => undefined,
        onConfirm: (c) => calls.confirm.push(c),
        onCancel: () => (calls.cancel += 1),
      }),
    );
    return calls;
  }

  it("shows the exact command, the script, the environment and the risk", () => {
    const withEnv = { ...candidate, env: { NODE_ENV: "development" }, cwd: "web app" };
    const calls = choices(withEnv, [withEnv]);
    const box = container.querySelector("[data-preview-confirm]")!;
    expect(box.textContent).toContain("npm run dev");
    expect(box.textContent).toContain("vite --port 5173");
    expect(box.textContent).toContain("NODE_ENV=development");
    expect(box.textContent).toContain("web app");
    expect(box.textContent).toContain("full rights");
    expect(box.textContent).toContain("does not count as sandboxed");
    const run = container.querySelector<HTMLButtonElement>("[data-preview-run]")!;
    expect(run.textContent).toBe("Run it");
    act(() => run.click());
    expect(calls.confirm).toEqual([withEnv]);
    expect(container.querySelector("[data-preview-problems]")?.textContent).toContain(
      "not an object",
    );
  });

  it("says when the same command was confirmed before, and asks nothing new", () => {
    recordPreviewConfirmed("/p", previewFingerprint(candidate));
    choices(candidate);
    expect(container.querySelector("[data-preview-run]")?.textContent).toBe("Start");
    expect(container.textContent).toContain("confirmed this exact command");
  });

  it("starts nothing until a candidate is picked, and explains an empty project", () => {
    choices(null);
    expect(container.querySelector("[data-preview-run]")).toBeNull();
    choices(null, []);
    expect(container.textContent).toContain("No .claude/launch.json configuration");
  });
});

describe("the verify card", () => {
  const failed = evaluateVerify({
    sessionId: "s1",
    turnKey: "u1",
    alive: true,
    newOutput: "TypeError: x is undefined\n",
    url: "http://localhost:5173/",
    http: { status: 500 },
    at: 1,
  });

  it("sends the report on a click, once", () => {
    const sent: string[] = [];
    render(
      createElement(VerifyCardView, {
        result: failed,
        checking: false,
        busy: false,
        onSend: (text: string) => {
          sent.push(text);
          return true;
        },
      }),
    );
    expect(container.querySelector("[data-verify-card]")?.getAttribute("data-verify-card")).toBe(
      "fail",
    );
    const button = container.querySelector<HTMLButtonElement>("[data-verify-send]")!;
    act(() => button.click());
    expect(sent).toEqual([failed.report]);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Sent");
  });

  it("cannot send while the chat is busy, and a pass has no button", () => {
    render(
      createElement(VerifyCardView, {
        result: failed,
        checking: false,
        busy: true,
        onSend: () => true,
      }),
    );
    expect(container.querySelector<HTMLButtonElement>("[data-verify-send]")!.disabled).toBe(true);
    const passed = evaluateVerify({
      sessionId: "s1",
      turnKey: "u1",
      alive: true,
      newOutput: "",
      url: "http://localhost:5173/",
      http: { status: 200 },
      at: 1,
    });
    render(
      createElement(VerifyCardView, {
        result: passed,
        checking: false,
        busy: false,
        onSend: () => true,
      }),
    );
    expect(container.querySelector("[data-verify-send]")).toBeNull();
    expect(container.textContent).toContain("Console errors and layout are not checked");
  });
});
