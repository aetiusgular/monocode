/**
 * #37: the preview's address. A preview runs on this Mac only, so every URL
 * the pane frames or the probe checks is loopback: localhost, 127.0.0.0/8 or
 * ::1. It is always shown as `localhost`, because App Transport Security
 * treats that name as local (step 3c plan, #37).
 *
 * The Rust probe checks again with `url::Url`, and connects only to loopback
 * addresses whatever a name resolves to. This file is the first check, for
 * what the interface shows.
 */

/** Terminal colour and cursor codes, which dev servers print around URLs. */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

function loopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  const parts = host.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * A preview URL on this Mac, as the pane frames it, or undefined. `0.0.0.0`
 * and `::` are what a server prints when it listens on every interface; the
 * pane still reaches it through localhost.
 */
export function normalizePreviewUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase();
  const anyInterface = host === "0.0.0.0" || host === "[::]";
  if (!anyInterface && !loopbackHost(host)) return undefined;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const path = `${url.pathname}${url.search}`;
  return `${url.protocol}//localhost:${port}${path || "/"}`;
}

const URL_IN_OUTPUT =
  /\bhttps?:\/\/(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s'"<>)\]]*)?/gi;

/**
 * The first preview URL a dev server printed, normalized. Vite, Next, Astro,
 * webpack and most others print one line with the local address.
 */
export function previewUrlFromOutput(output: string): string | undefined {
  const text = stripAnsi(output);
  for (const match of text.matchAll(URL_IN_OUTPUT)) {
    const url = normalizePreviewUrl(match[0].replace(/[.,;:]+$/, ""));
    if (url) return url;
  }
  return undefined;
}

/** The URL for a known port. */
export function previewUrlForPort(port: number): string | undefined {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return `http://localhost:${port}/`;
}
