// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  browserServerLabel,
  NO_SITE_NAMED,
  NOT_A_WEB_PAGE,
  SEVERAL_SITES,
  siteApprovalRequest,
  siteHost,
} from "./browserTools";
import { rememberSiteRule, siteRule } from "./siteRules";

const BROWSER_EXEC = "mcp__plugin_browser-use_browser-use__browser_exec";

describe("web fetch site requests", () => {
  it("names the host and keeps the full address and prompt", () => {
    const prompt = "Summarize the page.\n<b>not markup</b> **not bold**";
    expect(
      siteApprovalRequest("WebFetch", {
        url: "https://Example.com/a?b=1#c",
        prompt,
      }),
    ).toEqual({
      server: "Claude",
      host: "example.com",
      hosts: ["example.com"],
      ruleable: true,
      fetch: { url: "https://Example.com/a?b=1#c", prompt },
    });
  });

  it("offers no rule for a fetch it cannot place", () => {
    expect(
      siteApprovalRequest("WebFetch", { url: "", prompt: "x" }),
    ).toMatchObject({
      host: NO_SITE_NAMED,
      ruleable: false,
    });
    expect(
      siteApprovalRequest("WebFetch", {
        url: "file:///etc/passwd",
        prompt: "x",
      }),
    ).toMatchObject({ host: NOT_A_WEB_PAGE, ruleable: false, hosts: [] });
  });

  it("compares hosts without case or a trailing dot, and nothing else", () => {
    expect(siteHost("https://EXAMPLE.com./x")).toBe("example.com");
    expect(siteHost("https://example.com.:8443/")).toBe("example.com:8443");
    expect(siteHost("https://evil-example.com/")).toBe("evil-example.com");
    expect(siteHost("https://sub.example.com/")).toBe("sub.example.com");
    // Userinfo is not the host: the card names the site the fetch reaches.
    expect(siteHost("https://example.com@evil.com/")).toBe("evil.com");
    expect(siteHost("http://127.0.0.1:8080/")).toBe("127.0.0.1:8080");
    expect(siteHost("http://[::1]:3000/")).toBe("[::1]:3000");
  });
});

describe("browser tools from a plugin (5.16)", () => {
  it("recognises browser-use's plugin server and names it plainly", () => {
    expect(browserServerLabel("plugin_browser-use_browser-use")).toBe(
      "browser-use",
    );
    expect(browserServerLabel("playwright")).toBe("playwright");
    expect(
      siteApprovalRequest(
        "mcp__plugin_browser-use_browser-use__browser_navigate",
        {
          url: "https://news.example/a",
        },
      ),
    ).toMatchObject({
      server: "browser-use",
      host: "news.example",
      ruleable: true,
    });
  });

  it("reads the sites a browser_exec call's code names, and never offers a rule", () => {
    expect(
      siteApprovalRequest(BROWSER_EXEC, {
        code: "await page.goto('https://Example.com/login'); await page.click('#go')",
      }),
    ).toEqual({
      server: "browser-use",
      host: "example.com",
      hosts: ["example.com"],
      ruleable: false,
      code: true,
    });
    expect(
      siteApprovalRequest(BROWSER_EXEC, { code: 'navigate("docs.example")' }),
    ).toMatchObject({ host: "docs.example", ruleable: false });
    expect(
      siteApprovalRequest(BROWSER_EXEC, {
        code: "goto('https://a.example'); fetch('https://b.example/x')",
      }),
    ).toMatchObject({ host: SEVERAL_SITES, hosts: ["a.example", "b.example"] });
  });

  it("states that no website is named when it finds none", () => {
    expect(
      siteApprovalRequest(BROWSER_EXEC, { code: "return document.title" }),
    ).toMatchObject({
      host: NO_SITE_NAMED,
      hosts: [],
      ruleable: false,
      code: true,
    });
    expect(siteApprovalRequest(BROWSER_EXEC, {})).toMatchObject({
      host: NO_SITE_NAMED,
      code: true,
    });
  });

  it("leaves other tools on the plain card", () => {
    expect(
      siteApprovalRequest("Bash", { command: "curl https://x.example" }),
    ).toBeNull();
    expect(
      siteApprovalRequest("mcp__exa__crawl", { url: "https://a.example" }),
    ).toBeNull();
    expect(
      siteApprovalRequest(
        "mcp__plugin_browser-use_browser-use__browser_screenshot",
        {},
      ),
    ).toBeNull();
  });
});

describe("a website rule for one chat", () => {
  beforeEach(() => localStorage.clear());

  it("covers that host in that chat only", () => {
    rememberSiteRule("chat", "s1", "example.com", "always");
    expect(siteRule("s1", "/repo", "example.com")).toBe("always");
    expect(siteRule("s1", "/repo", "evil-example.com")).toBeNull();
    expect(siteRule("s1", "/repo", "sub.example.com")).toBeNull();
    expect(siteRule("s2", "/repo", "example.com")).toBeNull();
  });
});
