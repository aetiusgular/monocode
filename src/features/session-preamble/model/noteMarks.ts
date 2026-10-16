import { isNoteMark } from "../../../integrations/harness/core/noteFence";

/**
 * The mark each chat's launch notice names (security review K1). A new
 * provider conversation gets a new launch file and a new mark; later notes
 * use the mark of the conversation they go to. Kept in local storage so a
 * note after a restart still carries it; bounded like the receipts.
 */
const KEY = "monocode.noteMarks";
export const NOTE_MARKS_MAX = 500;

type Entry = { mark: string; at: number };

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function load(): Map<string, Entry> {
  const marks = new Map<string, Entry>();
  try {
    const raw = storage()?.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return marks;
    for (const item of parsed) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [id, entry] = item as [unknown, unknown];
      if (typeof id !== "string" || !id || !entry || typeof entry !== "object")
        continue;
      const { mark, at } = entry as Partial<Entry>;
      if (isNoteMark(mark) && typeof at === "number")
        marks.set(id, { mark, at });
    }
  } catch {
    // Unreadable storage holds no marks: notes then go without one.
  }
  return marks;
}

function save(marks: Map<string, Entry>): void {
  const entries = [...marks].sort((a, b) => b[1].at - a[1].at);
  try {
    storage()?.setItem(KEY, JSON.stringify(entries.slice(0, NOTE_MARKS_MAX)));
  } catch {
    // Full or blocked storage: the next note goes without a mark.
  }
}

export function noteMarkFor(sessionId: string): string | undefined {
  return load().get(sessionId)?.mark;
}

export function recordNoteMark(sessionId: string, mark: string): void {
  if (!sessionId || !isNoteMark(mark)) return;
  const marks = load();
  marks.set(sessionId, { mark, at: Date.now() });
  save(marks);
}

export function forgetNoteMark(sessionId: string): void {
  const marks = load();
  if (marks.delete(sessionId)) save(marks);
}
