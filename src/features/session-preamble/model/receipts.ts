/**
 * F2 receipts: what each provider session has already been given.
 *
 * Two receipts per chat. The chat's own id holds the instruction content
 * (global instructions, project notes, memory) and `start`, the hash of the
 * instructions and project notes the provider conversation was given when it
 * started. Finding 2.2 (13 Oct): changed instructions apply to new chats
 * only, so `start` stays for the life of that conversation and the open chat
 * shows a line when the current text differs. `appReceiptKey` holds MonoCode's
 * own parts (app access, preview status), which still reach a running chat
 * when they are new or change. The Mono mechanism (`planAgentContext`,
 * `recordAgentContext`) is separate.
 */

const KEY = "monocode.preambleReceipts";
/** Bounded, so receipts for long-deleted chats cannot grow without end. */
export const RECEIPTS_MAX = 500;

type Receipt = {
  /** The provider session the text went to; absent before its first reply. */
  provider?: string;
  hash: string;
  at: number;
  /**
   * Instruction receipts only: the hash of the instructions and project
   * notes the conversation started with. Absent when MonoCode does not know
   * (a receipt from before 13 Oct, or storage that was cleared).
   */
  start?: string;
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
      const { provider, hash, at, start } = value as Record<string, unknown>;
      if (typeof hash !== "string" || !hash) continue;
      out[id] = {
        ...(typeof provider === "string" && provider ? { provider } : {}),
        hash,
        at: typeof at === "number" ? at : 0,
        ...(typeof start === "string" && start ? { start } : {}),
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

/** The receipt for MonoCode's own parts of a chat's preamble. */
export function appReceiptKey(sessionId: string): string {
  return `${sessionId}#app`;
}

/**
 * Forget what was sent, so the next turn sends it again: after a compaction
 * on a harness with no native channel, or when the chat is deleted. Both
 * receipts go, and with them the start hash.
 */
export function forgetPreamble(sessionId: string): void {
  const receipts = load();
  const app = appReceiptKey(sessionId);
  if (!(sessionId in receipts) && !(app in receipts)) return;
  delete receipts[sessionId];
  delete receipts[app];
  store(receipts);
}

/**
 * After a compaction on a harness with a native channel: the instructions
 * stay in the system prompt, but app access went in a message and may be
 * gone, so only MonoCode's own parts go again.
 */
export function forgetAppReceipt(sessionId: string): void {
  const receipts = load();
  const app = appReceiptKey(sessionId);
  if (!(app in receipts)) return;
  delete receipts[app];
  store(receipts);
}

export function hasPreambleReceipt(sessionId: string): boolean {
  return sessionId in load();
}

/**
 * Whether this provider conversation already got the chat's instruction
 * content. A receipt made before the first reply belongs to whatever
 * conversation that reply started.
 */
export function conversationGiven(
  sessionId: string,
  providerSessionId: string | undefined,
): boolean {
  const receipt = load()[sessionId];
  return (
    !!receipt &&
    !!providerSessionId &&
    (receipt.provider == null || receipt.provider === providerSessionId)
  );
}

/**
 * Record a turn the provider accepted, for the instruction content.
 * `startedNow`: this turn gave the conversation its instructions (a new
 * conversation, or a harness with no native channel after a compaction).
 * A reply from another provider conversation than the receipt names also
 * means a new one started: with a native channel it got the current text at
 * launch; without one it got nothing, so the receipt goes and the next turn
 * sends the note. Otherwise the start hash is kept as it was.
 */
export function recordInstructions(
  sessionId: string,
  providerSessionId: string | undefined,
  start: string,
  options: { startedNow: boolean; native: boolean },
  now = Date.now(),
): void {
  const receipts = load();
  const prior = receipts[sessionId];
  const switched =
    !!prior?.provider &&
    !!providerSessionId &&
    prior.provider !== providerSessionId;
  if (switched && !options.native && !options.startedNow) {
    delete receipts[sessionId];
    store(receipts);
    return;
  }
  const kept = options.startedNow || switched ? start : prior?.start;
  receipts[sessionId] = {
    ...(providerSessionId
      ? { provider: providerSessionId }
      : prior?.provider && !options.startedNow
        ? { provider: prior.provider }
        : {}),
    hash: kept ?? prior?.hash ?? start,
    at: now,
    ...(kept ? { start: kept } : {}),
  };
  store(receipts);
}

/**
 * Whether the instructions or project notes changed after this chat's
 * provider conversation started. False when MonoCode does not know what it
 * started with, or the receipt belongs to another conversation.
 */
export function instructionsStale(
  sessionId: string,
  providerSessionId: string | undefined,
  current: string,
): boolean {
  const receipt = load()[sessionId];
  if (!receipt?.start) return false;
  if (
    providerSessionId &&
    receipt.provider &&
    receipt.provider !== providerSessionId
  )
    return false;
  return receipt.start !== current;
}
