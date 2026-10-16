import { consumeOperatorCommand } from "../../sessions/model/operatorCommand";

/**
 * Deep links (#44): `monocode-harness://new?prompt=<text>` fills a prompt in
 * the main window. A link never sends anything. Anyone can write a link, on a
 * web page, in an email or in a file, so the text is treated as a stranger's:
 * it is cleaned, bounded, and shown in the composer for you to read first.
 * A prompt that starts with /operator (or /mono, /monocode) is refused: sent,
 * it would give that chat app access, so only you may type it.
 *
 * The scheme is the fork's own, so it does not collide with an installed
 * upstream MonoCode. It must match `plugins.deep-link.desktop.schemes` in
 * `src-tauri/tauri.conf.json`.
 */

export const DEEP_LINK_SCHEME = "monocode-harness";
export const DEEP_LINK_ACTION = "new";
/** Longest link read at all. Longer ones are refused before parsing. */
export const MAX_LINK_LENGTH = 32_768;
/** Longest prompt a link may fill, after cleaning. Longer ones are refused, not cut. */
export const MAX_PROMPT_LENGTH = 8_000;
/** Why a link that starts with /operator is not used. */
export const OPERATOR_LINK_REASON =
  "A link cannot turn on app access. Type /operator yourself.";

export type DeepLinkPrompt = {
  ok: true;
  prompt: string;
  /** Characters removed by cleaning: control, bidirectional and zero-width. */
  removed: number;
};

export type DeepLinkRefusal = { ok: false; reason: string };

export type DeepLinkResult = DeepLinkPrompt | DeepLinkRefusal;

// C0 controls except tab and newline, DEL, and C1 controls.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// Bidirectional overrides, embeddings, isolates and marks: they can make the
// text read differently from what is sent.
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;
// Zero-width characters that hide text between visible words.
const ZERO_WIDTH = /[​-‍⁠﻿]/g;

/** Removes characters a reader cannot see. Returns the text and the count. */
export function cleanLinkText(text: string): { text: string; removed: number } {
  const unified = text.replace(/\r\n?/g, "\n");
  let removed = 0;
  const cleaned = unified
    .replace(CONTROL, () => {
      removed += 1;
      return "";
    })
    .replace(BIDI, () => {
      removed += 1;
      return "";
    })
    .replace(ZERO_WIDTH, () => {
      removed += 1;
      return "";
    });
  return { text: cleaned.trim(), removed };
}

function refuse(reason: string): DeepLinkRefusal {
  return { ok: false, reason };
}

/**
 * Reads one link. Only `monocode-harness://new?prompt=...` is accepted: no
 * user info, no port, no path, and no parameter other than one `prompt`.
 */
export function parseDeepLink(raw: unknown): DeepLinkResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return refuse("The link is empty.");
  }
  if (raw.length > MAX_LINK_LENGTH) {
    return refuse("The link is too long.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("The link could not be read.");
  }
  if (url.protocol.toLowerCase() !== `${DEEP_LINK_SCHEME}:`) {
    return refuse("The link is not a MonoCode link.");
  }
  if (url.username || url.password || url.port) {
    return refuse("The link carries a user name, password or port.");
  }
  const action = url.hostname.toLowerCase();
  if (action !== DEEP_LINK_ACTION || (url.pathname && url.pathname !== "/")) {
    return refuse("The link asks for something MonoCode does not do.");
  }
  const keys = [...url.searchParams.keys()];
  const unknown = keys.find((key) => key !== "prompt");
  if (unknown !== undefined) {
    return refuse("The link has a parameter MonoCode does not read.");
  }
  const prompts = url.searchParams.getAll("prompt");
  if (prompts.length !== 1) {
    return refuse(
      prompts.length === 0
        ? "The link has no prompt."
        : "The link has more than one prompt.",
    );
  }
  const { text, removed } = cleanLinkText(prompts[0]);
  if (!text) return refuse("The link's prompt is empty.");
  if (text.length > MAX_PROMPT_LENGTH) {
    return refuse(
      `The link's prompt is longer than ${MAX_PROMPT_LENGTH.toLocaleString("en-US")} characters.`,
    );
  }
  // The same match the composer uses to grant app access, after cleaning,
  // so hidden characters cannot slip it past. Agent-sent prompts refuse it
  // the same way (`agentPrompt`).
  if (consumeOperatorCommand(text).matched) return refuse(OPERATOR_LINK_REASON);
  return { ok: true, prompt: text, removed };
}

/** Builds a link that fills `prompt`. For tests and for a "copy link" later. */
export function buildDeepLink(prompt: string): string {
  const params = new URLSearchParams({ prompt });
  return `${DEEP_LINK_SCHEME}://${DEEP_LINK_ACTION}?${params.toString()}`;
}
