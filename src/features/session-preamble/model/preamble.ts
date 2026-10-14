/**
 * F2: one builder for what MonoCode tells an agent outside the user's words.
 * Each part has a budget (rule 5 of the step 3c plan): added text is capped
 * at 5% of the model's context window and never more than 24 KB. Parts are
 * cut in a fixed order, memory first and instructions last, and the result
 * says what did not fit so the interface can show it.
 */

/** The parts a regular session's preamble can hold, in the order they print. */
export type PreamblePartId =
  "instructions" | "project-notes" | "operator" | "memory" | "previews";

export type PreamblePart = {
  id: PreamblePartId;
  /** Shown in the interface: "Your instructions", "Project memory". */
  label: string;
  text: string;
  /**
   * Lines that may be dropped one at a time, oldest first, instead of the
   * whole part: memory entries. The newest entries that fit are kept.
   */
  lines?: string[];
  /** Never cut: the user switched it on for this thread (/operator). */
  required?: boolean;
};

/** Cut first to last. Required parts are never cut. */
export const CUT_ORDER: readonly PreamblePartId[] = [
  "memory",
  "previews",
  "project-notes",
  "operator",
  "instructions",
];

const PRINT_ORDER: readonly PreamblePartId[] = [
  "instructions",
  "project-notes",
  "operator",
  "memory",
  "previews",
];

/** Rule 5: added text is never more than 24 KB. */
export const PREAMBLE_MAX_BYTES = 24 * 1024;
/** Rule 5: added text is at most 5% of the context window. */
export const PREAMBLE_WINDOW_SHARE = 0.05;
/** The conversion used everywhere in the plans: about 4 characters a token. */
export const CHARS_PER_TOKEN = 4;
/** The window assumed when the model's is unknown: the local 7B's. */
export const UNKNOWN_WINDOW = 16_384;

/**
 * The smallest context window every model of a harness has, for a model
 * whose own window MonoCode does not know. Claude Code's built-in catalog
 * lists no window per model, and its Context setting offers 200k or 1M, so a
 * Claude Code session has at least 200,000 tokens. A harness not listed here
 * can run a small local model, so it keeps `UNKNOWN_WINDOW`.
 */
export const HARNESS_MIN_WINDOW: Readonly<Record<string, number>> = {
  claude: 200_000,
};

/**
 * The window to budget a session's preamble for: the model's own when known
 * (your setting under Settings, Models, then the harness catalog), else the
 * harness's smallest, else the small local one.
 */
export function preambleWindow(
  harness: string | undefined,
  modelWindow: number | undefined,
): number {
  if (modelWindow && Number.isFinite(modelWindow) && modelWindow > 0)
    return modelWindow;
  return (harness && HARNESS_MIN_WINDOW[harness]) || UNKNOWN_WINDOW;
}

/**
 * The budget in characters for a model with this context window. An unknown
 * window is budgeted as the smallest one in use, so a local model is never
 * flooded because its window was not set.
 */
export function preambleBudget(contextWindow?: number): number {
  const window =
    contextWindow && Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : UNKNOWN_WINDOW;
  return Math.min(
    PREAMBLE_MAX_BYTES,
    Math.floor(window * PREAMBLE_WINDOW_SHARE * CHARS_PER_TOKEN),
  );
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export type PreambleOmission = {
  id: PreamblePartId;
  label: string;
  /** Characters left out. */
  chars: number;
  /** Memory lines left out, when only some were. */
  lines?: number;
};

export type BuiltPreamble = {
  /** The parts that fit, joined, with no wrapper. Empty when nothing fits. */
  text: string;
  chars: number;
  budget: number;
  included: PreamblePartId[];
  omitted: PreambleOmission[];
  /** Over budget even after every cut, because of required parts. */
  overBudget: boolean;
  /** A stable hash of `text`, for receipts. */
  hash: string;
};

/**
 * How the parts are printed. "tagged" wraps each part in its id as a tag and
 * is what the native channel and the receipts' hash use. "plain" prints a
 * first-person heading per part, for the message channel, where the text
 * sits in the user's own message and must not look like harness markup.
 */
export type PreambleStyle = "tagged" | "plain";

/** Headings for the message channel, in the user's voice. */
export const MESSAGE_HEADINGS: Record<PreamblePartId, string> = {
  instructions: "My instructions",
  "project-notes": "My notes for this project",
  operator: "App access",
  // Saved entries may come from an agent's proposal, so they are not given
  // the user's voice (security review, F9).
  memory: "Notes MonoCode saved for this project",
  previews: "Preview server",
};

/** The operator part arrives wrapped in `<monocode_app>`; plain drops the tag. */
const WRAPPED = /^<([a-z_]+)>\n([\s\S]*)\n<\/\1>$/;

function section(
  part: PreamblePart,
  text: string,
  style: PreambleStyle,
): string {
  if (style === "tagged") return `<${part.id}>\n${text}\n</${part.id}>`;
  const body = text.trim().match(WRAPPED)?.[2] ?? text;
  return `${MESSAGE_HEADINGS[part.id]}:\n${body}`;
}

function render(
  parts: Map<PreamblePartId, { part: PreamblePart; text: string }>,
  style: PreambleStyle,
): string {
  return PRINT_ORDER.flatMap((id) => {
    const entry = parts.get(id);
    return entry && entry.text.trim()
      ? [section(entry.part, entry.text, style)]
      : [];
  }).join("\n\n");
}

/** FNV-1a, 32 bit, as hex: enough to tell one preamble from the next. */
export function preambleHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}:${text.length}`;
}

/**
 * Fit the parts into `budget` characters. A part with `lines` loses its
 * oldest lines first; any other part is dropped whole. Parts are cut in
 * `CUT_ORDER` until the whole fits.
 */
export function buildPreamble(
  parts: readonly PreamblePart[],
  budget: number,
  style: PreambleStyle = "tagged",
): BuiltPreamble {
  const kept = new Map<PreamblePartId, { part: PreamblePart; text: string }>();
  for (const part of parts) {
    const text = part.lines ? part.lines.join("\n") : part.text.trim();
    if (text.trim()) kept.set(part.id, { part, text });
  }
  const omitted: PreambleOmission[] = [];
  const fits = () => render(kept, style).length <= budget;
  for (const id of CUT_ORDER) {
    if (fits()) break;
    const entry = kept.get(id);
    if (!entry || entry.part.required) continue;
    if (entry.part.lines && entry.part.lines.length > 1) {
      // Drop the oldest lines until the whole fits, keeping at least one.
      const lines = [...entry.part.lines];
      let dropped = 0;
      let droppedChars = 0;
      while (lines.length > 1 && !fits()) {
        const [gone] = lines.splice(0, 1);
        dropped++;
        droppedChars += gone.length + 1;
        kept.set(id, { part: entry.part, text: lines.join("\n") });
      }
      if (fits()) {
        omitted.push({
          id,
          label: entry.part.label,
          chars: droppedChars,
          lines: dropped,
        });
        break;
      }
    }
    kept.delete(id);
    omitted.push({
      id,
      label: entry.part.label,
      chars: entry.part.lines
        ? entry.part.lines.join("\n").length
        : entry.text.length,
      ...(entry.part.lines ? { lines: entry.part.lines.length } : {}),
    });
  }
  const text = render(kept, style);
  return {
    text,
    chars: text.length,
    budget,
    included: PRINT_ORDER.filter((id) => kept.has(id)),
    omitted,
    overBudget: text.length > budget,
    hash: preambleHash(text),
  };
}

/**
 * What a message note carries. "current": instruction content on a harness
 * with no native channel, on the first turn of a provider conversation or
 * after a compaction MonoCode saw (also the first turn of a Claude Code chat
 * whose launch file could not be written). "app": only MonoCode's own parts
 * (app access, preview status) reaching a running chat. Finding 2.2 (13 Oct):
 * changed instructions apply to new chats only, so no note says the user
 * changed them.
 */
export type MessageBlockKind = "current" | "app";

export const MESSAGE_NOTE_START =
  "[Note from MonoCode, the app I run this chat in. It adds this on my behalf.]";
export const MESSAGE_NOTE_END = "[End of note.]";

const MESSAGE_LEAD: Record<MessageBlockKind, string> = {
  current:
    "These are my current instructions for this chat, set in MonoCode. They replace any earlier version you were given.",
  app: "This is MonoCode's note about app access and preview servers for this chat.",
};

/**
 * The message channel: a plain note in the user's voice, put in the user's
 * message by the user's app. Finding 2.2: a block in made-up tags that said
 * "the user did not type it" read as a prompt injection to Claude Sonnet 5,
 * which kept the earlier instructions. So this has no tags that look like
 * system or harness markup and is fenced from the user's own text by a
 * first and a last line.
 * `text` is the body built in the "plain" style.
 */
export function preambleBlock(
  text: string,
  kind: MessageBlockKind = "current",
): string {
  return `${MESSAGE_NOTE_START}\n${MESSAGE_LEAD[kind]}\n\n${withoutFence(text)}\n\n${MESSAGE_NOTE_END}`;
}

/**
 * A body may hold saved memory an agent proposed. The fence lines inside it
 * are replaced, so nothing in the body can close the note early and speak
 * as the user after it (security review, F9).
 */
function withoutFence(text: string): string {
  return text
    .split(MESSAGE_NOTE_END)
    .join("[end marker removed]")
    .split(MESSAGE_NOTE_START)
    .join("[start marker removed]");
}

/** Characters the note adds around its body, so the whole fits the budget. */
export function preambleBlockOverhead(kind: MessageBlockKind): number {
  return preambleBlock("", kind).length;
}

/**
 * Where the block goes. Ahead of the message so it reads as context, except
 * before a slash command, which must stay first.
 */
export function withPreambleBlock(
  message: string,
  block: string,
  commandFirst: boolean,
): string {
  if (!block) return message;
  return commandFirst ? `${message}\n\n${block}` : `${block}\n\n${message}`;
}

/** The native channel's text: the same parts, without the message wrapper. */
export function nativePreambleText(text: string): string {
  return `MonoCode, the app running this session, adds the following. It holds the user's standing instructions and what MonoCode knows about this project. Follow it below the user's current request.\n\n${text}`;
}
