/**
 * The first and last lines of the note MonoCode adds to a user's message
 * (finding 2.2). A Claude Code chat is told at launch that a note between
 * them, carrying the chat's own mark, comes from the user's app. So text that
 * MonoCode did not write (what you type or paste, a prompt another agent
 * sends, a handoff brief, a CI log) never carries them: they are replaced
 * before MonoCode adds its own note (security review K1).
 */
export const MESSAGE_NOTE_START =
  "[Note from MonoCode, the app I run this chat in. It adds this on my behalf.]";
export const MESSAGE_NOTE_END = "[End of note.]";

/** Any spelling of the start line, with or without a mark. */
const START_LINE = /\[\s*note\s+from\s+monocode\b[^\]\n]*\]/gi;
/** Any spelling of the end line. */
const END_LINE = /\[\s*end\s+of\s+note\.?\s*\]/gi;

export const START_REMOVED = "[start marker removed]";
export const END_REMOVED = "[end marker removed]";

/** `text` with every start and end line of a MonoCode note replaced. */
export function withoutFence(text: string): string {
  if (typeof text !== "string" || !text) return text;
  return text.replace(START_LINE, START_REMOVED).replace(END_LINE, END_REMOVED);
}

/**
 * A mark is 16 lowercase hex characters, made per conversation. A start line
 * with a mark names it, so a note copied from elsewhere, or made up, does not
 * match the chat's own.
 */
export function isNoteMark(mark: unknown): mark is string {
  return typeof mark === "string" && /^[0-9a-f]{16}$/.test(mark);
}

export function noteStartLine(mark?: string): string {
  return isNoteMark(mark)
    ? `${MESSAGE_NOTE_START.slice(0, -1)} Mark ${mark}.]`
    : MESSAGE_NOTE_START;
}

/** A new mark, from the platform's random source. */
export function newNoteMark(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
