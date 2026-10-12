import type { Block, HarnessId, Session } from "../../sessions/model/session";
import type {
  HarnessSessionRow,
  ImportedHistory,
  ImportedTurn,
} from "./types";

/** Rows shown in the picker. Newest first. */
export const MAX_SESSION_ROWS = 100;
/** Earlier turns brought into a picked-up chat. The newest are kept. */
export const MAX_IMPORTED_TURNS = 200;
/** Characters kept from one message. */
export const MAX_IMPORTED_TEXT = 20_000;
/** Characters kept across the whole import. */
export const MAX_IMPORTED_TOTAL = 300_000;
const MAX_TITLE = 120;
const MAX_DETAIL = 120;

/** A harness's own session or turn id: no path, flag or shell word. */
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isProviderSessionId(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_ID.test(value);
}

/**
 * Text a stranger may have written (a transcript on disk), made safe to show
 * as plain text: control characters other than line breaks and tabs removed,
 * trimmed and capped.
 */
export function cleanImportedText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** One line for a row title. */
export function oneLine(value: unknown, max = MAX_TITLE): string {
  return cleanImportedText(
    typeof value === "string" ? value.replace(/\s+/g, " ") : value,
    max,
  );
}

/**
 * The rows a harness reported, checked: a valid id, a one-line title, a
 * finite time. Duplicates keep the newest. Sorted newest first and capped.
 */
export function sanitizeSessionRows(rows: unknown): HarnessSessionRow[] {
  if (!Array.isArray(rows)) return [];
  const byId = new Map<string, HarnessSessionRow>();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    if (!isProviderSessionId(record.id)) continue;
    const updatedAt =
      typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
        ? Math.max(0, record.updatedAt)
        : 0;
    const title = oneLine(record.title) || "Untitled session";
    const detail = oneLine(record.detail, MAX_DETAIL);
    const row: HarnessSessionRow = {
      id: record.id,
      title,
      updatedAt,
      ...(detail ? { detail } : {}),
    };
    const seen = byId.get(row.id);
    if (!seen || seen.updatedAt < row.updatedAt) byId.set(row.id, row);
  }
  return [...byId.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .slice(0, MAX_SESSION_ROWS);
}

/**
 * Keeps the newest turns that fit the limits. Each message is capped; a turn
 * with no user text is dropped. `truncated` says something was left out.
 */
export function limitImportedHistory(
  turns: readonly ImportedTurn[],
  alreadyTruncated = false,
): ImportedHistory {
  let truncated = alreadyTruncated;
  const kept: ImportedTurn[] = [];
  let total = 0;
  for (let index = turns.length - 1; index >= 0; index--) {
    if (kept.length >= MAX_IMPORTED_TURNS) {
      truncated = true;
      break;
    }
    const turn = turns[index];
    const user = cleanImportedText(turn.user, MAX_IMPORTED_TEXT);
    if (!user) continue;
    const assistant = cleanImportedText(turn.assistant, MAX_IMPORTED_TEXT);
    if (
      user.length < (turn.user?.trim().length ?? 0) ||
      assistant.length < (turn.assistant?.trim().length ?? 0)
    ) {
      truncated = true;
    }
    const size = user.length + assistant.length;
    if (total + size > MAX_IMPORTED_TOTAL) {
      truncated = true;
      break;
    }
    total += size;
    kept.push({
      user,
      ...(assistant ? { assistant } : {}),
      ...(isProviderSessionId(turn.providerTurnId)
        ? { providerTurnId: turn.providerTurnId }
        : {}),
      ...(typeof turn.startedAt === "number" &&
      Number.isFinite(turn.startedAt) &&
      turn.startedAt > 0
        ? { startedAt: turn.startedAt }
        : {}),
    });
  }
  return { turns: kept.reverse(), truncated };
}

/**
 * Which harness sessions are already bound to a MonoCode chat, from the
 * open chats and the saved history. Provider id to MonoCode session id.
 */
export function boundProviderSessions(
  harness: HarnessId,
  ...lists: ReadonlyArray<
    ReadonlyArray<{
      id: string;
      harness: HarnessId;
      providerSessionId?: string;
      archived?: boolean;
    }>
  >
): Map<string, string> {
  const bound = new Map<string, string>();
  for (const list of lists) {
    for (const entry of list) {
      if (entry.harness !== harness || !entry.providerSessionId) continue;
      if (!bound.has(entry.providerSessionId)) {
        bound.set(entry.providerSessionId, entry.id);
      }
    }
  }
  return bound;
}

function blockId(): string {
  return crypto.randomUUID();
}

/** The notice at the top of a picked-up chat. */
export function pickUpNotice(input: {
  harnessLabel: string;
  providerSessionId: string;
  history: ImportedHistory | null;
  /** Why earlier turns are not shown, when the harness was asked and failed. */
  reason?: string;
}): string {
  const { harnessLabel, providerSessionId, history, reason } = input;
  const head = `Picked up ${harnessLabel} session ${providerSessionId}.`;
  if (!history) {
    const why = reason ? ` ${reason.replace(/\.$/, "")}.` : "";
    return `${head} Earlier turns are not shown here.${why} The agent still has them.`;
  }
  if (history.turns.length === 0) {
    return `${head} It has no earlier turns to show.`;
  }
  return history.truncated
    ? `${head} The newest ${history.turns.length} turns are shown; older turns or long messages were cut. The agent still has all of them.`
    : `${head} Its earlier turns are shown below.`;
}

/** Plain user and assistant blocks for the imported turns. */
export function importedBlocks(history: ImportedHistory): Block[] {
  const blocks: Block[] = [];
  for (const turn of history.turns) {
    blocks.push({
      id: blockId(),
      role: "user",
      text: turn.user,
      ...(turn.providerTurnId ? { providerTurnId: turn.providerTurnId } : {}),
      ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
    });
    if (turn.assistant) {
      blocks.push({ id: blockId(), role: "assistant", text: turn.assistant });
    }
  }
  return blocks;
}

/**
 * The chat that continues a harness session. `base` is a fresh session with
 * the source chat's harness, folder, model and account. The chat is bound to
 * the harness's id; nothing is sent until you write the next prompt.
 */
export function pickedUpSession(input: {
  base: Session;
  row: HarnessSessionRow;
  harnessLabel: string;
  history: ImportedHistory | null;
  reason?: string;
}): Session {
  const { base, row, history } = input;
  const notice: Block = {
    id: blockId(),
    role: "system",
    text: pickUpNotice({
      harnessLabel: input.harnessLabel,
      providerSessionId: row.id,
      history,
      ...(input.reason ? { reason: input.reason } : {}),
    }),
  };
  return {
    ...base,
    title: oneLine(row.title, 80) || base.title,
    providerSessionId: row.id,
    blocks: [notice, ...(history ? importedBlocks(history) : [])],
  };
}

/** "3 min ago", "yesterday", or a date, for a row. */
export function rowAge(updatedAt: number, now = Date.now()): string {
  if (!updatedAt) return "";
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(updatedAt).toISOString().slice(0, 10);
}
