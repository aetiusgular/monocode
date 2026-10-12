/**
 * Agent browsing with site approval (#38b).
 *
 * MonoCode has no browser of its own (step 3c rule 7). An agent browses with a
 * browser MCP server, such as Playwright. This module finds those servers by
 * name, and reads the site a browser tool call is about to open, so the
 * approval card can name the host and keep a rule per site.
 *
 * - Matching is by server name only, as research mode does for search tools:
 *   MonoCode does not see a server's tool list before a turn starts.
 * - Site rules are enforced where MonoCode sees a tool's name and arguments.
 *   That is Claude Code only. Codex sends an MCP confirmation with no tool
 *   name or arguments, and the other harnesses do not name the tool.
 */

/** Lowercase letters and digits of server names that drive a browser. */
const BROWSER_KEYS = [
  "playwright",
  "playwrightmcp",
  "microsoftplaywright",
  "puppeteer",
  "browser",
  "browsermcp",
  "browseruse",
  "browserbase",
  "chromedevtools",
  "chromedevtoolsmcp",
  "devtools",
  "chrome",
  "selenium",
  "stagehand",
  "hyperbrowser",
  "steel",
  "steelbrowser",
  "webbrowser",
  "headlessbrowser",
];

function key(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** True when an MCP server's name says it drives a browser. */
export function isBrowserServer(name: string): boolean {
  const k = key(name);
  if (!k) return false;
  return BROWSER_KEYS.some(
    (known) => k === known || k.startsWith(known) || k.endsWith(known),
  );
}

/** The browser servers among a chat's MCP servers, in their order. */
export function browserServers(names: readonly string[]): string[] {
  return [...new Set(names.filter(isBrowserServer))];
}

/**
 * The server of a Claude Code MCP tool (`mcp__<server>__<tool>`), when that
 * server drives a browser. Claude Code turns other characters in a server's
 * name into `_`, so the match runs on the letters and digits.
 */
export function browserToolServer(toolName: string): string | null {
  const match = /^mcp__(.+?)__.+$/.exec(toolName);
  if (!match) return null;
  return isBrowserServer(match[1]) ? match[1] : null;
}

const URL_KEYS = [
  "url",
  "href",
  "uri",
  "link",
  "pageUrl",
  "page_url",
  "targetUrl",
  "target_url",
  "address",
];

const MAX_URL = 4096;

export type SiteRequest = {
  server: string;
  /** Lowercase host with port, from the URL parser. */
  host: string;
};

/**
 * The site a browser tool call opens, or null when it names none. A call
 * that names a page MonoCode cannot read as an http(s) address (`file:`,
 * `javascript:`, `data:`, garbage) gets the host "(not a web page)", so it is
 * never covered by a site rule and always shows the card.
 */
export function browserSiteRequest(
  toolName: string,
  input: Record<string, unknown>,
): SiteRequest | null {
  const server = browserToolServer(toolName);
  if (!server) return null;
  for (const field of URL_KEYS) {
    const raw = input[field];
    if (typeof raw !== "string" || !raw.trim()) continue;
    return { server, host: siteHost(raw) ?? NOT_A_WEB_PAGE };
  }
  return null;
}

export const NOT_A_WEB_PAGE = "(not a web page)";

/** The host of an http(s) address, lowercase with its port, or null. */
export function siteHost(raw: string): string | null {
  if (raw.length > MAX_URL) return null;
  let url: URL;
  try {
    // A bare host such as `example.com/path` is how models often write it.
    url = new URL(
      /^[a-z][a-z0-9+.-]*:/i.test(raw.trim())
        ? raw.trim()
        : `https://${raw.trim()}`,
    );
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return url.host.toLowerCase();
}

/** The message Claude Code gets for a site the user blocked. */
export function blockedSiteMessage(host: string): string {
  return `The user blocked ${host} for browser tools in this chat or project. Do not open it.`;
}
