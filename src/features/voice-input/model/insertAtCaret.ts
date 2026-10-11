/** Where the caret was when recording started. */
export type CaretSnapshot = { value: string; start: number; end: number };

export function caretSnapshot(field: HTMLTextAreaElement): CaretSnapshot {
  const end = field.value.length;
  return {
    value: field.value,
    start: field.selectionStart ?? end,
    end: field.selectionEnd ?? end,
  };
}

/**
 * The text to put between `before` and `after`, with a space on either side
 * where it would otherwise run into a word.
 */
export function spacedInsert(
  before: string,
  text: string,
  after: string,
): string {
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  return `${lead}${text}${trail}`;
}

/**
 * Puts dictated text where the caret was when recording started, replacing
 * any selection then. If the draft changed while recording, it goes at the
 * caret as it is now. Fires `input` so the composer's React state follows,
 * and leaves the caret after the text. Never sends.
 */
export function insertAtCaret(
  field: HTMLTextAreaElement,
  text: string,
  captured: CaretSnapshot | null,
): void {
  if (!text) return;
  const unchanged = captured != null && field.value === captured.value;
  const length = field.value.length;
  const start = Math.min(
    length,
    unchanged ? captured.start : (field.selectionStart ?? length),
  );
  const end = Math.min(
    length,
    Math.max(start, unchanged ? captured.end : (field.selectionEnd ?? start)),
  );
  const insert = spacedInsert(
    field.value.slice(0, start),
    text,
    field.value.slice(end),
  );
  field.focus();
  field.setRangeText(insert, start, end, "end");
  const caret = start + insert.length;
  field.setSelectionRange(caret, caret);
  // A raw `input` event is what React listens for.
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
