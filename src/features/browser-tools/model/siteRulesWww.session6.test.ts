import { beforeEach, describe, expect, it } from "vitest";
import { rememberSiteRule, siteRule, wwwTwin } from "./siteRules";
import { siteApprovalRequest } from "./browserTools";

/**
 * Security fix F5: Claude Code's WebFetch follows a redirect between `x.com`
 * and `www.x.com` on its own, so a site rule treats both as one host.
 */

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
  });
});

const hostOf = (url: string) =>
  siteApprovalRequest("WebFetch", { url, prompt: "x" })!.host;

describe("www and the bare host are one site (F5)", () => {
  it("Never on the bare host blocks www, and the reverse", () => {
    rememberSiteRule("chat", "s1", "x.com", "never");
    expect(siteRule("s1", "/p", hostOf("https://www.x.com/a"))).toBe("never");
    rememberSiteRule("project", "/p", "www.evil.example", "never");
    expect(siteRule("s2", "/p", hostOf("https://evil.example/"))).toBe("never");
  });

  it("Always on either form allows both", () => {
    rememberSiteRule("chat", "s1", "www.docs.rs", "always");
    expect(siteRule("s1", "/p", "docs.rs")).toBe("always");
    expect(siteRule("s1", "/p", "www.docs.rs")).toBe("always");
  });

  it("Never on one form beats Always on the other", () => {
    rememberSiteRule("chat", "s1", "x.com", "always");
    rememberSiteRule("project", "/p", "www.x.com", "never");
    expect(siteRule("s1", "/p", "x.com")).toBe("never");
  });

  it("keeps the port and leaves IPs and other subdomains alone", () => {
    expect(wwwTwin("x.com:8080")).toBe("www.x.com:8080");
    expect(wwwTwin("www.x.com")).toBe("x.com");
    expect(wwwTwin("127.0.0.1:3000")).toBeNull();
    expect(wwwTwin("[::1]:3000")).toBeNull();
    expect(wwwTwin("localhost:3000")).toBeNull();
    expect(wwwTwin("www.com")).toBeNull();
    rememberSiteRule("chat", "s1", "x.com", "never");
    expect(siteRule("s1", "/p", "api.x.com")).toBeNull();
    expect(siteRule("s1", "/p", "x.com:8080")).toBeNull();
  });
});
