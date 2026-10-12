/**
 * The document side of the sandboxed frame (F5).
 *
 * The Rust scheme sends a CSP header with every response. Whether WebKit
 * honours a header on a custom-scheme response has not been checked on the
 * Mac (step 3c, section 14), so the same policy also goes into the document
 * as a `<meta>` tag. Two policies are both enforced, so a page's own meta tag
 * can only narrow this one, never widen it.
 */
export const FRAME_META_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const META = `<meta http-equiv="Content-Security-Policy" content="${FRAME_META_CSP}">`;

const DOCTYPE = /^(﻿?\s*<!doctype[^>]*>)/i;

/**
 * Put the policy at the very start of the document, after a doctype when
 * there is one so the page keeps standards mode. The parser moves a leading
 * `<meta>` into `<head>`, ahead of any script the page carries.
 */
export function withFrameMeta(html: string): string {
  const match = DOCTYPE.exec(html);
  if (match) {
    const head = match[1];
    return `${head}${META}${html.slice(head.length)}`;
  }
  return `${META}${html}`;
}

/**
 * How a frame shows a document.
 *
 * - `scripts`: the `mcpreview` scheme in `<iframe sandbox="allow-scripts">`.
 * - `static`: `srcdoc` in `<iframe sandbox="">`. No script runs at all. This
 *   is the fallback if check 8 on the Mac fails (the script does not run, or
 *   `window.__TAURI_INTERNALS__` is defined inside the frame). Session 6 flips
 *   the default in one line if it does.
 */
export type FrameMode = "scripts" | "static";

export const DEFAULT_FRAME_MODE: FrameMode = "scripts";

const MODE_KEY = "monocode.sandboxFrame.mode";

export function frameMode(): FrameMode {
  try {
    const stored = globalThis.localStorage?.getItem(MODE_KEY);
    return stored === "static" || stored === "scripts"
      ? stored
      : DEFAULT_FRAME_MODE;
  } catch {
    return DEFAULT_FRAME_MODE;
  }
}

export function setFrameMode(mode: FrameMode): void {
  try {
    globalThis.localStorage?.setItem(MODE_KEY, mode);
  } catch {
    // Storage can be unavailable; the default stays in force.
  }
}

/** UTF-8 length, as the Rust store counts it. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** The iframe attributes for a mode. Never `allow-same-origin`. */
export function frameSandbox(mode: FrameMode): string {
  return mode === "scripts" ? "allow-scripts" : "";
}
