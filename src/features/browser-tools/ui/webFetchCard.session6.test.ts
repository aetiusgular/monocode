// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../sessions/model/session";
import { ApprovalControls } from "../../sessions/ui/AgentTranscript";
import { NO_SITE_NAMED } from "../model/browserTools";
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

type Site = NonNullable<NonNullable<Block["approval"]>["site"]>;

const PROMPT =
  "Summarize it.\n<img src=x onerror=alert(1)> **bold?** [link](https://evil.example)";
const FETCH: Site = {
  server: "Claude",
  host: "example.com",
  hosts: ["example.com"],
  ruleable: true,
  chatKey: "s1",
  projectKey: "/repo",
  fetch: { url: "https://Example.com/a b?c=<d>", prompt: PROMPT },
};

const buttons = () =>
  [...container.querySelectorAll("button")].map((b) => b.textContent);
const click = (label: string) =>
  act(() =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === label)!
      .click(),
  );
const render = (
  site: Site,
  onApproval = vi.fn(),
  remember = vi.fn(() => true),
) => {
  act(() =>
    root.render(
      createElement(SiteControls, { requestId: 8, site, onApproval, remember }),
    ),
  );
  return { onApproval, remember };
};

describe("the web fetch card", () => {
  it("shows the site, the full address and the prompt as plain text", () => {
    render(FETCH);
    expect(container.textContent).toContain("Claude wants to fetch a web page");
    expect(container.textContent).toContain("example.com");
    expect(container.querySelector("[data-web-fetch-url]")!.textContent).toBe(
      "https://Example.com/a b?c=<d>",
    );
    expect(
      container.querySelector("[data-web-fetch-prompt]")!.textContent,
    ).toBe(PROMPT);
    // Nothing from the input becomes markup.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("strong")).toBeNull();
    expect(buttons()).toEqual([
      "Decline",
      "Always allow for this website",
      "Allow once",
    ]);
  });

  it("keeps the rule on this chat for this host, before it answers", () => {
    const order: string[] = [];
    const remember = vi.fn(() => {
      order.push("remember");
      return true;
    });
    const onApproval = vi.fn(() => {
      order.push("answer");
    });
    render(FETCH, onApproval, remember);
    click("Always allow for this website");
    expect(remember).toHaveBeenCalledWith(
      "chat",
      "s1",
      "example.com",
      "always",
    );
    expect(onApproval).toHaveBeenCalledWith(8, "allow");
    expect(order).toEqual(["remember", "answer"]);
  });

  it("Allow once and Decline keep nothing", () => {
    const { onApproval, remember } = render(FETCH);
    click("Allow once");
    expect(onApproval).toHaveBeenLastCalledWith(8, "allow");
    click("Decline");
    expect(onApproval).toHaveBeenLastCalledWith(8, "deny");
    expect(remember).not.toHaveBeenCalled();
  });

  it("offers no rule when the fetch names no website", () => {
    render({ ...FETCH, host: NO_SITE_NAMED, hosts: [], ruleable: false });
    expect(buttons()).toEqual(["Decline", "Allow once"]);
  });

  it("replaces Allow and Deny on the approval card", () => {
    const block = {
      id: "b",
      role: "tool",
      text: "",
      approval: {
        requestId: 8,
        tool: { key: "WebFetch", label: "WebFetch" },
        site: FETCH,
      },
    } as unknown as Block;
    act(() =>
      root.render(
        createElement(ApprovalControls, { block, onApproval: vi.fn() }),
      ),
    );
    expect(buttons()).not.toContain("Allow for this chat");
    expect(buttons()).toContain("Always allow for this website");
  });
});

describe("the browser code card (5.16)", () => {
  const CODE: Site = {
    server: "browser-use",
    host: NO_SITE_NAMED,
    hosts: [],
    ruleable: false,
    code: true,
    chatKey: "s1",
    projectKey: "/repo",
  };

  it("says no website is named and offers Allow once and Decline only", () => {
    render(CODE);
    expect(container.textContent).toContain("No website named in this call");
    expect(buttons()).toEqual(["Allow once", "Decline"]);
  });

  it("names the sites the code opens, still with no rule", () => {
    render({ ...CODE, host: "example.com", hosts: ["example.com"] });
    expect(container.textContent).toContain(
      "browser-use wants to run code in the browser on example.com",
    );
    expect(buttons()).toEqual(["Allow once", "Decline"]);
  });
});
