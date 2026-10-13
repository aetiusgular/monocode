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

/** Shown for a call that names no website; no rule can cover it. */
export const NO_SITE_NAMED = "(no website named)";
/** Saved for a call that names more than one website. */
export const SEVERAL_SITES = "(several websites)";

/** Input keys that carry code a browser tool runs. */
const CODE_KEYS = [
  "code",
  "script",
  "function",
  "expression",
  "js",
  "javascript",
  "source",
];
const MAX_SCANNED = 64 * 1024;
const MAX_SHOWN = 64 * 1024;

/** A site card's request: the host or hosts, and whether a rule may answer it. */
export type SiteApproval = SiteRequest & {
  /** Every host the call names, lowercase. Empty when it names none. */
  hosts: string[];
  /**
   * True when a site's "always" rule may answer this call. False for a call
   * that names no website, several, a page that is not a web page, or runs
   * code: code can open any site, whatever site it names.
   */
  ruleable: boolean;
  /** The call runs code in the browser. */
  code?: boolean;
  /** Claude Code's own WebFetch: the address and the prompt, as given. */
  fetch?: { url: string; prompt: string };
};

/**
 * A browser server's name as people know it. Claude Code names a plugin's
 * server `plugin_<plugin>_<server>`; browser-use's is
 * `plugin_browser-use_browser-use`, shown as "browser-use".
 */
export function browserServerLabel(server: string): string {
  if (!server.startsWith("plugin_")) return server;
  const rest = server.slice("plugin_".length);
  const half = /^(.+)_\1$/.exec(rest);
  return half ? half[1] : rest;
}

/** Hosts of the http(s) address literals in code, in order, without repeats. */
function hostsInCode(code: string): string[] {
  const out: string[] = [];
  const text = code.slice(0, MAX_SCANNED);
  for (const match of text.matchAll(/https?:\/\/[^\s'"`<>()\\]+/gi)) {
    const host = siteHost(match[0]);
    if (host && !out.includes(host)) out.push(host);
  }
  // `goto("example.com")` with no scheme still names a site.
  for (const match of text.matchAll(
    /\b(?:goto|navigate|navigateTo|open)\(\s*(['"`])([^'"`\s]+)\1/g,
  )) {
    const host = siteHost(match[2]);
    if (host && !out.includes(host)) out.push(host);
  }
  return out;
}

function clip(text: string): string {
  return text.length > MAX_SHOWN ? text.slice(0, MAX_SHOWN) : text;
}

/**
 * The site card a tool call gets, or null for the plain card.
 *
 * - Claude Code's `WebFetch`: the host of its `url`, with the address and
 *   the prompt to show in full.
 * - A browser server's tool (plugin servers such as browser-use included)
 *   with an address field: that host, as before.
 * - A browser tool that runs code (`browser_exec`): the hosts its code
 *   names, or none. A rule never answers it.
 */
export function siteApprovalRequest(
  toolName: string,
  input: Record<string, unknown>,
): SiteApproval | null {
  if (toolName === "WebFetch") {
    const url = typeof input.url === "string" ? input.url : "";
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    const host = url.trim() ? (siteHost(url) ?? NOT_A_WEB_PAGE) : NO_SITE_NAMED;
    const ruleable = host !== NOT_A_WEB_PAGE && host !== NO_SITE_NAMED;
    return {
      server: "Claude",
      host,
      hosts: ruleable ? [host] : [],
      ruleable,
      fetch: { url: clip(url), prompt: clip(prompt) },
    };
  }
  const site = browserSiteRequest(toolName, input);
  const server = browserToolServer(toolName);
  if (site) {
    const ruleable = site.host !== NOT_A_WEB_PAGE;
    return {
      server: browserServerLabel(site.server),
      host: site.host,
      hosts: ruleable ? [site.host] : [],
      ruleable,
    };
  }
  if (!server) return null;
  // A tool that runs code, by its input or its name (browser-use's
  // `browser_exec`). Its other string arguments are read for addresses too.
  const tool = toolName.slice(toolName.lastIndexOf("__") + 2);
  const runsCode =
    CODE_KEYS.some((key) => typeof input[key] === "string") ||
    /exec|eval|script|javascript|run_code|evaluate/i.test(tool);
  if (!runsCode) return null;
  const code = Object.values(input)
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  const hosts = hostsInCode(code);
  return {
    server: browserServerLabel(server),
    host:
      hosts.length === 0
        ? NO_SITE_NAMED
        : hosts.length === 1
          ? hosts[0]
          : SEVERAL_SITES,
    hosts,
    ruleable: false,
    code: true,
  };
}

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
  // `example.com.` is the same site as `example.com`.
  const host = url.host.toLowerCase();
  const dotless = url.hostname.endsWith(".")
    ? host.replace(url.hostname, url.hostname.replace(/\.+$/, ""))
    : host;
  return dotless.startsWith(":") || dotless === "" ? null : dotless;
}

/** The message Claude Code gets for a site the user blocked. */
export function blockedSiteMessage(host: string): string {
  return `The user blocked ${host} for browser tools in this chat or project. Do not open it.`;
}

/** The message Claude Code gets for a web fetch to a blocked site. */
export function blockedFetchMessage(host: string): string {
  return `The user blocked ${host} for web fetches in this chat or project. Do not fetch it.`;
}
