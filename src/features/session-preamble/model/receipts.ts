/**
 * F2 receipts: what each provider session has already been given. The text
 * goes once, and again only when it changes or the provider session changes:
 * a new conversation, a harness or model switch that starts one, a compaction
 * MonoCode saw, or "Send instructions again". The Mono mechanism
 * (`planAgentContext`, `recordAgentContext`) works the same way.
 */

const KEY = "monocode.preambleReceipts";
/** Bounded, so receipts for long-deleted chats cannot grow without end. */
export const RECEIPTS_MAX = 500;

type Receipt = {
  /** The provider session the text went to; absent before its first reply. */
  provider?: string;
  hash: string;
  at: number;
};

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function load(): Record<string, Receipt> {
  try {
    const raw = storage()?.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const out: Record<string, Receipt> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const { provider, hash, at } = value as Record<string, unknown>;
      if (typeof hash !== "string" || !hash) continue;
      out[id] = {
        ...(typeof provider === "string" && provider ? { provider } : {}),
        hash,
        at: typeof at === "number" ? at : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function store(next: Record<string, Receipt>): void {
  const entries = Object.entries(next);
  const kept =
    entries.length > RECEIPTS_MAX
      ? Object.fromEntries(
          entries.sort((a, b) => b[1].at - a[1].at).slice(0, RECEIPTS_MAX),
        )
      : next;
  try {
    storage()?.setItem(KEY, JSON.stringify(kept));
  } catch {
    // Without the receipt the next turn sends the text again, which is safe.
  }
}

/**
 * Whether this turn must carry the preamble by message. A provider session
 * that already holds this text gets nothing. One that has never seen it, or
 * saw another version, gets it.
 */
export function preambleDue(
  sessionId: string,
  providerSessionId: string | undefined,
  hash: string,
): boolean {
  const receipt = load()[sessionId];
  if (!receipt) return true;
  // The provider id arrives with the first reply, so a receipt made before
  // it belongs to whatever conversation that reply started.
  const sameSession =
    !!providerSessionId &&
    (receipt.provider == null || receipt.provider === providerSessionId);
  return !sameSession || receipt.hash !== hash;
}

/** Record what a turn the provider accepted carried. */
export function recordPreamble(
  sessionId: string,
  providerSessionId: string | undefined,
  hash: string,
  now = Date.now(),
): void {
  store({
    ...load(),
    [sessionId]: {
      ...(providerSessionId ? { provider: providerSessionId } : {}),
      hash,
      at: now,
    },
  });
}

/**
 * Forget what was sent, so the next turn sends it again: after a compaction,
 * or when the user asks for "Send instructions again". Also when the chat is
 * deleted.
 */
export function forgetPreamble(sessionId: string): void {
  const receipts = load();
  if (!(sessionId in receipts)) return;
  delete receipts[sessionId];
  store(receipts);
}

export function hasPreambleReceipt(sessionId: string): boolean {
  return sessionId in load();
}

/**
 * Whether this provider session was already given another version of the
 * text: the user changed it mid-conversation. False when there is no
 * receipt, the receipt belongs to another provider session, or the text is
 * the same.
 */
export function preambleChanged(
  sessionId: string,
  providerSessionId: string | undefined,
  hash: string,
): boolean {
  const receipt = load()[sessionId];
  if (!receipt || !providerSessionId) return false;
  const sameSession =
    receipt.provider == null || receipt.provider === providerSessionId;
  return sameSession && receipt.hash !== hash;
}
