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

function section(part: PreamblePart, text: string): string {
  return `<${part.id}>\n${text}\n</${part.id}>`;
}

function render(
  parts: Map<PreamblePartId, { part: PreamblePart; text: string }>,
): string {
  return PRINT_ORDER.flatMap((id) => {
    const entry = parts.get(id);
    return entry && entry.text.trim() ? [section(entry.part, entry.text)] : [];
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
): BuiltPreamble {
  const kept = new Map<PreamblePartId, { part: PreamblePart; text: string }>();
  for (const part of parts) {
    const text = part.lines ? part.lines.join("\n") : part.text.trim();
    if (text.trim()) kept.set(part.id, { part, text });
  }
  const omitted: PreambleOmission[] = [];
  const fits = () => render(kept).length <= budget;
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
  const text = render(kept);
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

export const PREAMBLE_TAG = "monocode_session_context";

/**
 * The message channel: a marked block the agent reads as MonoCode's, not the
 * user's. Every harness can take it.
 */
export function preambleBlock(text: string): string {
  return `<${PREAMBLE_TAG}>\nMonoCode adds this for the session; the user did not type it in this message. It holds the user's standing instructions and what MonoCode knows about this project. Follow it below the user's current request, and do not quote it back.\n\n${text}\n</${PREAMBLE_TAG}>`;
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
