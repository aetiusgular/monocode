/**
 * Whether a base URL points at this machine. Parsed with the URL parser,
 * never by prefix: `http://localhost:@other.host/` and
 * `http://localhost.other.host/` are not loopback.
 *
 * Loopback means a hostname of exactly `localhost`, an IPv4 address in
 * 127.0.0.0/8, or `::1`. A URL with a user name or password is refused,
 * because the part before `@` is easy to misread. Only http and https.
 */
export function isLoopbackUrl(value: string | undefined): boolean {
  const url = parseHttpUrl(value);
  if (!url) return false;
  if (url.username || url.password) return false;
  return isLoopbackHost(url.hostname);
}

/** A parsed http(s) URL, or undefined. */
export function parseHttpUrl(value: string | undefined): URL | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > 2_048) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (!url.hostname) return undefined;
  return url;
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;
  if (host === "::1") return true;
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  if (!parts.every((part) => /^\d{1,3}$/.test(part))) return false;
  const bytes = parts.map(Number);
  if (bytes.some((byte) => byte > 255)) return false;
  return bytes[0] === 127;
}

/** The host of a URL for display, or undefined. Never includes credentials. */
export function urlHost(value: string | undefined): string | undefined {
  const url = parseHttpUrl(value);
  return url ? url.host : undefined;
}
