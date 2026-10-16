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

/**
 * After `readableLine`, where every run of spacing is one space: a line that
 * starts with any opening bracket or quote, then the words, each apart
 * (security review M3). Only single optional characters, so matching is
 * linear (N1), and camelCase or snake_case code does not read as the words
 * (N2). The note is a whole line, so a line that only mentions the words
 * further on is left alone; a line that names the chat's mark goes anyway.
 */
const START_LINE = /^ ?[\p{Ps}\p{Pi}(<] ?note from mono ?-? ?code(?![a-z0-9])/u;
const END_LINE = /^ ?[\p{Ps}\p{Pi}(<] ?end of (?:the )?note(?![a-z0-9])/u;
/**
 * Inside MonoCode's own note the body is the user's saved text and memory
 * an agent proposed, so a fence word anywhere in a line goes (security
 * review F9): nothing in it may close the note early.
 */
const START_ANYWHERE =
  /[\p{Ps}\p{Pi}(<] ?note from mono ?-? ?code(?![a-z0-9])/u;
const END_ANYWHERE = /[\p{Ps}\p{Pi}(<] ?end of (?:the )?note(?![a-z0-9])/u;
const MARKS = /[\p{Mn}\p{Me}]/gu;
const FORMAT = /\p{Cf}/gu;
/** Markdown emphasis, dropped. */
const EMPHASIS = /[*_`~]/g;
/** Any run of spacing, fillers that look like a space included. */
const SPACING = /[\s\u3164\u2800\u115f\u1160\uffa0]+/g;

/**
 * Letters from other scripts that look like the Latin ones in the fence
 * words and in a mark, keyed on what NFKD and lowercasing leave (security
 * review M5). In a mark, o reads as 0 and l or i as 1.
 */
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  "\u0430": "a",
  "\u03b1": "a",
  "\u044c": "b",
  "\u0185": "b",
  "\u0441": "c",
  "\u03c2": "c",
  "\u03f2": "c",
  "\u2ca5": "c",
  "\ua4da": "c",
  "\u0501": "d",
  "\ua4d3": "d",
  "\u0435": "e",
  "\u03b5": "e",
  "\ua4f0": "e",
  "\u0192": "f",
  "\u0433": "r",
  "\u0280": "r",
  "\u043c": "m",
  "\u03bc": "m",
  "\ua4df": "m",
  // Cherokee Ꮇ lowercases to U+AB87 before the fold (N3).
  "\uab87": "m",
  "\u0578": "n",
  "\u03bd": "v",
  "\u043f": "n",
  "\u043e": "o",
  "\u03bf": "o",
  "\u0585": "o",
  "\u2c9f": "o",
  "\u1d0f": "o",
  "\ua4f3": "o",
  "\u0442": "t",
  "\u03c4": "t",
  "\ua4d4": "t",
  "\u0456": "i",
  "\u0131": "i",
};
const LOOK_ALIKE = new RegExp(`[${Object.keys(LOOK_ALIKES).join("")}]`, "g");

/**
 * A line as a reader sees it, for matching only. An invisible format
 * character (a zero-width space, a joiner, a bidi control) may stand inside
 * a word or between two, so `asBreak` reads it as a space and the default
 * drops it.
 */
export function readableLine(line: string, asBreak = false): string {
  return (
    line
      // NFKD folds compatibility forms and splits accents off their letters,
      // so the accents go with the other marks.
      .normalize("NFKD")
      .replace(MARKS, "")
      .replace(FORMAT, asBreak ? " " : "")
      .toLowerCase()
      // Only the listed characters reach the callback (security review M6).
      .replace(LOOK_ALIKE, (ch) => LOOK_ALIKES[ch] ?? ch)
      .replace(EMPHASIS, "")
      .replace(SPACING, " ")
  );
}

function readsAs(line: string, pattern: RegExp): boolean {
  return (
    pattern.test(readableLine(line)) || pattern.test(readableLine(line, true))
  );
}

/** A mark spelled over more lines than this is not read as one (N6). */
const MARK_LINES_MAX = 4;

/**
 * The hex digits a reader could take for a mark: o as 0, l and i as 1,
 * everything that is not a hex digit dropped (security review M4).
 */
function hexReading(seen: string): string {
  return seen
    .replace(/o/g, "0")
    .replace(/[li]/g, "1")
    .replace(/[^0-9a-f]/g, "");
}

/**
 * `text` with every line that reads as a start or end line of a MonoCode
 * note replaced, and, given the chat's mark, every line that spells it out
 * on its own or together with the lines next to it.
 */
export function withoutFence(
  text: string,
  mark?: string,
  { anywhere = false }: { anywhere?: boolean } = {},
): string {
  if (typeof text !== "string" || !text) return text;
  const start = anywhere ? START_ANYWHERE : START_LINE;
  const end = anywhere ? END_ANYWHERE : END_LINE;
  const lines = text.split("\n");
  const out = lines.map((line) => {
    if (readsAs(line, start)) return endWith(line, START_REMOVED);
    if (readsAs(line, end)) return endWith(line, END_REMOVED);
    return line;
  });
  if (isNoteMark(mark)) {
    // One reading of the whole text, with each hex digit's line, so a mark
    // split over lines is found too.
    let hex = "";
    const lineOf: number[] = [];
    lines.forEach((line, index) => {
      const digits = hexReading(readableLine(line));
      hex += digits;
      for (let i = 0; i < digits.length; i++) lineOf.push(index);
    });
    let from = hex.indexOf(mark);
    while (from >= 0) {
      const first = lineOf[from]!;
      const last = lineOf[from + mark.length - 1]!;
      if (last - first < MARK_LINES_MAX)
        for (let index = first; index <= last; index++)
          out[index] = endWith(lines[index]!, MARK_REMOVED);
      from = hex.indexOf(mark, from + 1);
    }
  }
  return out.join("\n");
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
