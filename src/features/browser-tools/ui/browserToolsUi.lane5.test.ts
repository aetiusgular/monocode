// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../sessions/model/session";
import { ApprovalControls } from "../../sessions/ui/AgentTranscript";
import { NOT_A_WEB_PAGE } from "../model/browserTools";
import {
  BrowserToolsMenuItem,
  browserToolsNotes,
  browserToolsOn,
  withBrowserTools,
} from "./BrowserToolsMenuItem";
import { SiteControls } from "./SiteControls";

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

const SITE = {
  server: "playwright",
  host: "news.example",
  chatKey: "s1",
  projectKey: "/repo",
};

const buttons = () =>
  [...container.querySelectorAll("button")].map((b) => b.textContent);
const click = (label: string) =>
  act(() =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === label)!
      .click(),
  );

describe("SiteControls", () => {
  it("names the server and host, and offers the four choices", () => {
    act(() =>
      root.render(
        createElement(SiteControls, {
          requestId: 5,
          site: SITE,
          onApproval: vi.fn(),
        }),
      ),
    );
    expect(container.textContent).toContain(
      "playwright wants to open news.example",
    );
    expect(buttons()).toEqual([
      "Allow once",
      "Always for this chat",
      "Always for this project",
      "Never",
    ]);
  });

  it("saves the rule under the adapter's keys before it answers", () => {
    const order: string[] = [];
    const remember = vi.fn(() => {
      order.push("remember");
      return true;
    });
    const onApproval = vi.fn(() => {
      order.push("answer");
    });
    const render = () =>
      act(() =>
        root.render(
          createElement(SiteControls, {
            requestId: 5,
            site: SITE,
            onApproval,
            remember,
          }),
        ),
      );
    render();
    click("Always for this chat");
    expect(remember).toHaveBeenLastCalledWith(
      "chat",
      "s1",
      "news.example",
      "always",
    );
    expect(onApproval).toHaveBeenLastCalledWith(5, "allow");
    expect(order.slice(0, 2)).toEqual(["remember", "answer"]);
    click("Always for this project");
    expect(remember).toHaveBeenLastCalledWith(
      "project",
      "/repo",
      "news.example",
      "always",
    );
    click("Never");
    expect(remember).toHaveBeenLastCalledWith(
      "chat",
      "s1",
      "news.example",
      "never",
    );
    expect(onApproval).toHaveBeenLastCalledWith(5, "deny");
    remember.mockClear();
    click("Allow once");
    expect(remember).not.toHaveBeenCalled();
    expect(onApproval).toHaveBeenLastCalledWith(5, "allow");
  });

  it("offers no rule for a page that is not a web address", () => {
    act(() =>
      root.render(
        createElement(SiteControls, {
          requestId: 5,
          site: { ...SITE, host: NOT_A_WEB_PAGE },
          onApproval: vi.fn(),
        }),
      ),
    );
    expect(buttons()).toEqual(["Allow once", "Deny"]);
  });

  it("replaces Allow and Deny on the approval card", () => {
    const block = {
      id: "b",
      role: "tool",
      text: "",
      approval: { requestId: 5, site: SITE },
    } as unknown as Block;
    act(() =>
      root.render(
        createElement(ApprovalControls, { block, onApproval: vi.fn() }),
      ),
    );
    expect(buttons()[0]).toBe("Allow once");
    expect(buttons()).not.toContain("Allow");
  });
});

describe("Browser tools in the plus menu", () => {
  it("switches every browser server on or off together, keeping the rest", () => {
    const servers = ["playwright", "chrome-devtools"];
    expect(withBrowserTools(servers, ["exa"], false)).toEqual([
      "exa",
      "playwright",
      "chrome-devtools",
    ]);
    expect(withBrowserTools(servers, ["exa", "playwright"], true)).toEqual([
      "exa",
    ]);
    expect(browserToolsOn(servers, ["exa"])).toBe(true);
    expect(browserToolsOn(servers, ["playwright"])).toBe(false);
    expect(browserToolsOn([], [])).toBe(false);
  });

  it("says where sites are asked, and that Full access never asks", () => {
    expect(browserToolsNotes("claude", "supervised")[0]).toContain(
      "asks first",
    );
    expect(browserToolsNotes("claude", "full-access")[0]).toContain(
      "Full access never asks",
    );
    expect(browserToolsNotes("codex", "supervised")[0]).toContain(
      "not asked on this harness",
    );
  });

  it("renders only when the chat has a browser server, and toggles", () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        createElement(BrowserToolsMenuItem, {
          servers: [],
          disabled: [],
          harness: "claude",
          runtimeMode: "supervised",
          onChange,
        }),
      ),
    );
    expect(container.querySelector("[data-browser-tools]")).toBeNull();
    act(() =>
      root.render(
        createElement(BrowserToolsMenuItem, {
          servers: ["playwright"],
          disabled: [],
          harness: "claude",
          runtimeMode: "full-access",
          onChange,
        }),
      ),
    );
    const item = container.querySelector<HTMLButtonElement>(
      "[data-browser-tools]",
    )!;
    expect(item.getAttribute("aria-checked")).toBe("true");
    expect(item.textContent).toContain("playwright");
    expect(item.textContent).toContain("Full access never asks");
    act(() => item.click());
    expect(onChange).toHaveBeenCalledWith(["playwright"]);
  });
});
