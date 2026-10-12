// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyHarnessEvent } from "../../integrations/harness/core/apply";
import { sanitizeSessionForPersist } from "../sessions/data/sessionStore";
import { newSession, type Block } from "../sessions/model/session";
import { ApprovalControls } from "../sessions/ui/AgentTranscript";
import { SignInControls } from "./ui/SignInControls";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => undefined),
}));

let container: HTMLDivElement;
let root: Root;

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

const SIGN_IN = {
  server: "github",
  message: "Sign in to GitHub <img src=x onerror=alert(1)>",
  url: "https://github.com/login/device?state=secret-state",
  host: "github.com",
};

const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

describe("SignInControls", () => {
  it("shows the server's text and the full address as plain text", () => {
    act(() =>
      root.render(
        createElement(SignInControls, {
          requestId: 4,
          signIn: SIGN_IN,
          onApproval: vi.fn(),
        }),
      ),
    );
    expect(container.textContent).toContain(
      "From github: Sign in to GitHub <img",
    );
    expect(container.textContent).toContain(SIGN_IN.url);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  it("opens the page only on the click, then allows", async () => {
    const open = vi.fn(async () => undefined);
    const onApproval = vi.fn();
    act(() =>
      root.render(
        createElement(SignInControls, {
          requestId: 4,
          signIn: SIGN_IN,
          onApproval,
          open,
        }),
      ),
    );
    expect(open).not.toHaveBeenCalled();
    act(() =>
      container
        .querySelector<HTMLButtonElement>("[data-mcp-signin-open]")!
        .click(),
    );
    await flush();
    expect(open).toHaveBeenCalledWith(SIGN_IN.url);
    expect(onApproval).toHaveBeenCalledWith(4, "allow");
  });

  it("declines when the page cannot be opened, or on Cancel", async () => {
    const onApproval = vi.fn();
    const open = vi.fn(async () => {
      throw new Error("blocked");
    });
    act(() =>
      root.render(
        createElement(SignInControls, {
          requestId: 4,
          signIn: SIGN_IN,
          onApproval,
          open,
        }),
      ),
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>("[data-mcp-signin-open]")!
        .click(),
    );
    await flush();
    expect(onApproval).toHaveBeenLastCalledWith(4, "deny");
    act(() =>
      container
        .querySelector<HTMLButtonElement>("[data-mcp-signin-cancel]")!
        .click(),
    );
    expect(onApproval).toHaveBeenLastCalledWith(4, "deny");
  });

  it("replaces Allow and Deny on the approval card", () => {
    const block = {
      id: "b",
      role: "approval",
      text: "",
      approval: { requestId: 4, signIn: SIGN_IN },
    } as unknown as Block;
    act(() =>
      root.render(
        createElement(ApprovalControls, { block, onApproval: vi.fn() }),
      ),
    );
    const labels = [...container.querySelectorAll("button")].map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(["Open sign-in page", "Cancel"]);
  });
});

describe("a sign-in card in the transcript and in storage", () => {
  it("carries the sign-in onto the block, and never stores the address", () => {
    let session = newSession("codex", "/repo");
    session = applyHarnessEvent(session, {
      type: "approval.requested",
      requestId: 4,
      title: "github (MCP server) asks you to sign in at github.com",
      kind: "other",
      signIn: SIGN_IN,
    });
    const block = session.blocks.find((b) => b.approval?.requestId === 4);
    expect(block?.approval?.signIn).toEqual(SIGN_IN);
    session = applyHarnessEvent(session, {
      type: "approval.resolved",
      requestId: 4,
      decision: "allow",
    });
    const saved = sanitizeSessionForPersist(session).blocks.find(
      (b) => b.approval?.requestId === 4,
    );
    expect(saved?.approval?.signIn).toEqual({
      server: "github",
      host: "github.com",
    });
    expect(JSON.stringify(saved)).not.toContain("secret-state");
  });

  it("drops a stored sign-in whose host is not a host", () => {
    const session = newSession("codex", "/repo");
    session.blocks = [
      { id: "u", role: "user", text: "hi" },
      {
        id: "b",
        role: "approval",
        text: "",
        approval: {
          requestId: 4,
          decided: "deny",
          signIn: { server: "x<script>", host: "<img src=x>" },
        },
      } as Block,
    ];
    const saved = sanitizeSessionForPersist(session).blocks.find(
      (b) => b.approval?.requestId === 4,
    );
    expect(saved?.approval?.signIn).toBeUndefined();
  });
});
