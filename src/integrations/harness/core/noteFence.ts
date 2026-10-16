/**
 * The first and last lines of the note MonoCode adds to a user's message
 * (finding 2.2). A Claude Code chat is told at launch that a note between
 * them, carrying the chat's own mark, comes from the user's app. So text that
 * MonoCode did not write (what you type or paste, a prompt another agent
 * sends, a handoff brief, a CI log) never carries them: such lines are
 * replaced before MonoCode adds its own note (security review K1).
 *
 * Lines are read the way a model would see them (security review L5):
 * compatibility forms folded (full-width brackets), invisible characters
 * dropped (zero-width, joiners, bidi controls, tags, combining marks), and
 * letters from other scripts that look like the Latin ones in the fence
 * words folded. A line that then reads as a fence line, or names the chat's
 * mark, is replaced whole. Every pattern is bounded, so a long prompt costs
 * linear time (security review L2).
 */
export const MESSAGE_NOTE_START =
  "[Note from MonoCode, the app I run this chat in. It adds this on my behalf.]";
export const MESSAGE_NOTE_END = "[End of note.]";

export const START_REMOVED = "[start marker removed]";
export const END_REMOVED = "[end marker removed]";
export const MARK_REMOVED = "[line with this chat's mark removed]";

const START_LINE = /\[\s{0,20}note\s{1,20}from\s{1,20}monocode(?![a-z0-9])/;
const END_LINE = /\[\s{0,20}end\s{1,20}of\s{1,20}note(?![a-z0-9])/;
const INVISIBLE = /[\p{Cf}\p{Mn}\p{Me}]/gu;

/** Cyrillic and Greek letters that look like the Latin ones in the fence words. */
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  а: "a",
  А: "a",
  α: "a",
  Α: "a",
  с: "c",
  С: "c",
  ϲ: "c",
  ԁ: "d",
  е: "e",
  Е: "e",
  ε: "e",
  Ε: "e",
  г: "r",
  м: "m",
  М: "m",
  Μ: "m",
  ո: "n",
  Ν: "n",
  о: "o",
  О: "o",
  ο: "o",
  Ο: "o",
  т: "t",
  Т: "t",
  τ: "t",
  Τ: "t",
  і: "i",
  І: "i",
};

/** A line as a reader sees it, for matching only. */
export function readableLine(line: string): string {
  return line
    // NFKD folds compatibility forms and splits accents off their letters,
    // so the accents go with the other invisible marks.
    .normalize("NFKD")
    .replace(INVISIBLE, "")
    .replace(/[^\u0000-\u007f]/g, (ch) => LOOK_ALIKES[ch] ?? ch)
    .toLowerCase();
}

/**
 * `text` with every line that reads as a start or end line of a MonoCode
 * note replaced, and, given the chat's mark, every line that names it.
 */
export function withoutFence(text: string, mark?: string): string {
  if (typeof text !== "string" || !text) return text;
  const markKey = isNoteMark(mark) ? mark : undefined;
  return text
    .split("\n")
    .map((line) => {
      const seen = readableLine(line);
      if (START_LINE.test(seen)) return endWith(line, START_REMOVED);
      if (END_LINE.test(seen)) return endWith(line, END_REMOVED);
      if (markKey && seen.includes(markKey)) return endWith(line, MARK_REMOVED);
      return line;
    })
    .join("\n");
}

/** Keep a line's carriage return, so CRLF text stays CRLF. */
function endWith(line: string, replacement: string): string {
  return line.endsWith("\r") ? `${replacement}\r` : replacement;
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

/**
 * The chat's mark, for callers in the harness core that hold only a session
 * id. The preamble feature registers the lookup; with none, no mark.
 */
let markLookup: ((sessionId: string) => string | undefined) | null = null;

export function setNoteMarkLookup(
  lookup: ((sessionId: string) => string | undefined) | null,
): void {
  markLookup = lookup;
}

/** `withoutFence` with the chat's own mark, when one is known. */
export function withoutFenceFor(sessionId: string, text: string): string {
  let mark: string | undefined;
  try {
    mark = markLookup?.(sessionId);
  } catch {
    mark = undefined;
  }
  return withoutFence(text, mark);
}
