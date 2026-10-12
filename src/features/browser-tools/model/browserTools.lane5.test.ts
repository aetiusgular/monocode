// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  blockedSiteMessage,
  browserServers,
  browserSiteRequest,
  browserToolServer,
  isBrowserServer,
  NOT_A_WEB_PAGE,
  siteHost,
} from "./browserTools";
import { codexMcpResultImages } from "./codexMcpImages";
import {
  forgetSiteRules,
  readSiteRules,
  rememberSiteRule,
  siteRule,
} from "./siteRules";

describe("browser servers by name", () => {
  it("finds the usual browser servers", () => {
    for (const name of [
      "playwright",
      "Playwright",
      "microsoft-playwright",
      "puppeteer",
      "browser-use",
      "browsermcp",
      "chrome-devtools",
      "browserbase",
      "selenium",
    ])
      expect(isBrowserServer(name)).toBe(true);
  });

  it("leaves other servers alone", () => {
    for (const name of ["exa", "github", "linear", "filesystem", "", "--"])
      expect(isBrowserServer(name)).toBe(false);
    expect(
      browserServers(["exa", "playwright", "playwright", "github"]),
    ).toEqual(["playwright"]);
  });

  it("reads the server of a Claude Code MCP tool", () => {
    expect(browserToolServer("mcp__playwright__browser_navigate")).toBe(
      "playwright",
    );
    expect(browserToolServer("mcp__chrome-devtools__navigate_page")).toBe(
      "chrome-devtools",
    );
    expect(browserToolServer("mcp__exa__web_search_exa")).toBeNull();
    expect(browserToolServer("WebFetch")).toBeNull();
    expect(browserToolServer("Bash")).toBeNull();
  });
});

describe("the site a browser call opens", () => {
  it("reads the host of an http(s) address, lowercase with its port", () => {
    expect(siteHost("https://Example.COM/a?b")).toBe("example.com");
    expect(siteHost("http://localhost:5173/")).toBe("localhost:5173");
    expect(siteHost("example.com/path")).toBe("example.com");
    expect(siteHost("https://xn--bcher-kva.example/")).toBe(
      "xn--bcher-kva.example",
    );
  });

  it("gives no host for other schemes or junk", () => {
    for (const raw of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,x",
      "chrome://settings",
      "http://",
      "a".repeat(5000),
    ])
      expect(siteHost(raw)).toBeNull();
  });

  it("names the host for a browser tool, and marks a page that is not one", () => {
    expect(
      browserSiteRequest("mcp__playwright__browser_navigate", {
        url: "https://news.example/a",
      }),
    ).toEqual({ server: "playwright", host: "news.example" });
    expect(
      browserSiteRequest("mcp__playwright__browser_navigate", {
        url: "file:///Users/me/.ssh/id_rsa",
      }),
    ).toEqual({ server: "playwright", host: NOT_A_WEB_PAGE });
    expect(
      browserSiteRequest("mcp__puppeteer__puppeteer_navigate", {
        href: "http://127.0.0.1:3000",
      })?.host,
    ).toBe("127.0.0.1:3000");
  });

  it("is null for a browser call with no address, or another tool", () => {
    expect(
      browserSiteRequest("mcp__playwright__browser_click", { ref: "e1" }),
    ).toBeNull();
    expect(
      browserSiteRequest("mcp__exa__crawl", { url: "https://a.example" }),
    ).toBeNull();
  });

  it("tells the agent a blocked site stays shut", () => {
    expect(blockedSiteMessage("a.example")).toContain("a.example");
  });
});

describe("site rules", () => {
  beforeEach(() => localStorage.clear());

  it("keeps chat and project rules apart", () => {
    rememberSiteRule("chat", "s1", "a.example", "always");
    rememberSiteRule("project", "/repo", "b.example", "always");
    expect(siteRule("s1", "/repo", "a.example")).toBe("always");
    expect(siteRule("s2", "/repo", "a.example")).toBeNull();
    expect(siteRule("s2", "/repo", "b.example")).toBe("always");
    expect(siteRule("s2", "/other", "b.example")).toBeNull();
  });

  it("lets never win over always, from either scope", () => {
    rememberSiteRule("project", "/repo", "a.example", "always");
    rememberSiteRule("chat", "s1", "a.example", "never");
    expect(siteRule("s1", "/repo", "a.example")).toBe("never");
    rememberSiteRule("chat", "s2", "b.example", "always");
    rememberSiteRule("project", "/repo", "b.example", "never");
    expect(siteRule("s2", "/repo", "b.example")).toBe("never");
  });

  it("forgets a host or a whole chat", () => {
    rememberSiteRule("chat", "s1", "a.example", "always");
    rememberSiteRule("chat", "s1", "b.example", "always");
    forgetSiteRules("chat", "s1", "a.example");
    expect(siteRule("s1", "/r", "a.example")).toBeNull();
    expect(siteRule("s1", "/r", "b.example")).toBe("always");
    forgetSiteRules("chat", "s1");
    expect(readSiteRules().chat.s1).toBeUndefined();
  });

  it("reads garbage, odd hosts and odd decisions as no rule", () => {
    localStorage.setItem("monocode.browserSiteRules", "{not json");
    expect(siteRule("s1", "/r", "a.example")).toBeNull();
    localStorage.setItem(
      "monocode.browserSiteRules",
      JSON.stringify({
        chat: {
          s1: { "<img>": "always", "a.example": "maybe", "b.example": "never" },
        },
        project: [],
      }),
    );
    expect(readSiteRules()).toEqual({
      chat: { s1: { "b.example": "never" } },
      project: {},
    });
  });

  it("keeps at most 200 hosts per chat, newest last", () => {
    for (let i = 0; i < 205; i++)
      rememberSiteRule("chat", "s1", `h${i}.example`, "always");
    const hosts = Object.keys(readSiteRules().chat.s1);
    expect(hosts).toHaveLength(200);
    expect(hosts.at(-1)).toBe("h204.example");
    expect(hosts).not.toContain("h0.example");
  });
});

describe("Codex MCP screenshots", () => {
  const done = (content: unknown[], threadId = "thr_1") => ({
    threadId,
    item: {
      type: "mcpToolCall",
      id: "call_1",
      server: "playwright",
      tool: "browser_take_screenshot",
      status: "completed",
      result: { content },
    },
  });

  it("finds image blocks in a finished call", () => {
    expect(
      codexMcpResultImages(
        "item/completed",
        done([
          { type: "text", text: "ok" },
          { type: "image", data: "iVBOR", mimeType: "image/png" },
        ]),
        "thr_1",
      ),
    ).toEqual({
      callId: "call_1",
      images: [{ data: "iVBOR", mimeType: "image/png" }],
    });
  });

  it("ignores other types, other threads, unfinished calls and text", () => {
    const svg = done([{ type: "image", data: "x", mimeType: "image/svg+xml" }]);
    expect(codexMcpResultImages("item/completed", svg, "thr_1")).toBeNull();
    const png = done(
      [{ type: "image", data: "x", mimeType: "image/png" }],
      "child",
    );
    expect(codexMcpResultImages("item/completed", png, "thr_1")).toBeNull();
    expect(codexMcpResultImages("item/started", png, "child")).toBeNull();
    expect(
      codexMcpResultImages("item/completed", done([{ type: "text" }]), "thr_1"),
    ).toBeNull();
  });
});
