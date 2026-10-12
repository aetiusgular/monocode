/**
 * Work that runs beside a turn: a shell the agent backgrounded, a subagent,
 * a monitor, or a server MonoCode started itself. The harness reports its
 * own items; MonoCode adds the processes it owns.
 */
export type BackgroundItemKind = "shell" | "subagent" | "monitor" | "server";

export type BackgroundItemStatus = "running" | "stopping" | "done" | "failed";

export type BackgroundItem = {
  /** Unique within its source: a harness task id, or an owned process id. */
  id: string;
  kind: BackgroundItemKind;
  title: string;
  status: BackgroundItemStatus;
  /** Epoch ms, when known. */
  startedAt?: number;
  /** True when a stop for this one item exists: the harness's or MonoCode's. */
  stoppable: boolean;
  /** Who reported it, and so who can stop it. */
  source: "harness" | "monocode";
};

export const BACKGROUND_KINDS: readonly BackgroundItemKind[] = [
  "shell",
  "subagent",
  "monitor",
  "server",
];

/** Items a harness reports are capped so a runaway list cannot flood the UI. */
export const MAX_BACKGROUND_ITEMS = 100;
const MAX_TITLE = 300;
const MAX_ID = 200;

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // Control characters out, so a title cannot move the cursor or hide text.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

/** One item read from untrusted input, or null when it is not one. */
export function sanitizeBackgroundItem(value: unknown): BackgroundItem | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = cleanText(raw.id, MAX_ID);
  if (!id) return null;
  const kind = BACKGROUND_KINDS.includes(raw.kind as BackgroundItemKind)
    ? (raw.kind as BackgroundItemKind)
    : "shell";
  const status: BackgroundItemStatus =
    raw.status === "stopping" ||
    raw.status === "done" ||
    raw.status === "failed"
      ? raw.status
      : "running";
  const title = cleanText(raw.title, MAX_TITLE) || "Background task";
  const startedAt =
    typeof raw.startedAt === "number" &&
    Number.isFinite(raw.startedAt) &&
    raw.startedAt > 0
      ? raw.startedAt
      : undefined;
  return {
    id,
    kind,
    title,
    status,
    ...(startedAt ? { startedAt } : {}),
    stoppable: raw.stoppable === true,
    source: raw.source === "monocode" ? "monocode" : "harness",
  };
}

export function sanitizeBackgroundItems(value: unknown): BackgroundItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: BackgroundItem[] = [];
  for (const entry of value) {
    const item = sanitizeBackgroundItem(entry);
    if (!item) continue;
    const key = `${item.source}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= MAX_BACKGROUND_ITEMS) break;
  }
  return out;
}

/** A stable key for a list, so adapters skip sending the same list twice. */
export function backgroundItemsKey(items: readonly BackgroundItem[]): string {
  return items
    .map((item) =>
      [item.source, item.id, item.kind, item.status, item.title, item.stoppable]
        .map(String)
        .join("\u0001"),
    )
    .join("\u0002");
}

/** Running first, then newest first; items with no start time last. */
export function sortBackgroundItems(
  items: readonly BackgroundItem[],
): BackgroundItem[] {
  const rank = (status: BackgroundItemStatus) =>
    status === "running" ? 0 : status === "stopping" ? 1 : 2;
  return [...items].sort(
    (a, b) =>
      rank(a.status) - rank(b.status) ||
      (b.startedAt ?? 0) - (a.startedAt ?? 0) ||
      a.title.localeCompare(b.title),
  );
}
