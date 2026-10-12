import { harnessCan } from "../../../integrations/harness/core/capabilities";
import type { Block, HarnessId, Session } from "../../sessions/model/session";

/**
 * Rewind and fork at any earlier prompt (#34). Three separate actions:
 *
 * - Rewind chat: the harness forgets everything from this prompt on, and the
 *   transcript is cut before it. Files are left as they are.
 * - Restore files: MonoCode's own checkpoint puts the folder back to how it
 *   was before the turn. The conversation is left as it is.
 * - Fork: a new chat with the conversation up to the end of this turn. Native
 *   on Claude Code and Codex; everywhere else, and wherever the native call
 *   lacks what it needs, a new conversation seeded with the transcript,
 *   labelled approximate.
 */

export type RewindAction = "chat" | "files" | "fork";

export type RewindChoice = {
  enabled: boolean;
  /** Shown when the action is off, so the user knows why. */
  reason?: string;
};

export type ForkPlan =
  | { mode: "native"; harness: "codex"; lastTurnId?: string }
  | { mode: "native"; harness: "claude"; at?: string }
  | { mode: "approximate"; reason: string };

export type RewindOptions = {
  blockId: string;
  /** Index of the first user block of the turn this prompt belongs to. */
  turnStart: number;
  /** Index one past the turn's last block. */
  turnEnd: number;
  isLastTurn: boolean;
  /** Prompts after this turn, which a chat rewind also takes back. */
  laterPrompts: number;
  chat: RewindChoice & { providerTurnId?: string };
  files: RewindChoice & { checkpointTurnId?: string };
  fork: RewindChoice & { plan: ForkPlan };
};

export type RewindContext = {
  /** Another busy chat shares this checkout (SessionPane's undo lock). */
  sharedCheckout?: boolean;
};

/** A prompt the user wrote and sent: not internal, a draft or still queued. */
export function isRewindablePrompt(session: Session, block: Block): boolean {
  return (
    block.role === "user" &&
    !block.internal &&
    !block.draft &&
    !session.queuedMessages?.some((message) => message.blockId === block.id)
  );
}

/**
 * The first user block of the turn `index` belongs to. Codex steers a
 * follow-up into the running turn, so blocks that share a provider turn id
 * are one turn.
 */
export function turnStartIndex(blocks: readonly Block[], index: number): number {
  const turnId = blocks[index]?.providerTurnId;
  if (!turnId) return index;
  let start = index;
  for (let i = index - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.role !== "user") continue;
    if (block.providerTurnId !== turnId) break;
    start = i;
  }
  return start;
}

/** One past the last block of the turn that starts at `start`. */
export function turnEndIndex(session: Session, start: number): number {
  const turnId = session.blocks[start]?.providerTurnId;
  for (let i = start + 1; i < session.blocks.length; i += 1) {
    const block = session.blocks[i];
    if (!isRewindablePrompt(session, block)) continue;
    if (turnId && block.providerTurnId === turnId) continue;
    return i;
  }
  return session.blocks.length;
}

/** Why nothing can be rewound right now, if so. */
export function sessionRewindBlocker(session: Session): string | undefined {
  if (session.busy) return "Stop the current turn first";
  if (session.pendingQuestion) return "Answer or skip the open question first";
  if (session.inboxAsk) return "Not available for an inbox question";
  if ((session.queuedMessages?.length ?? 0) > 0)
    return "Send or clear the queued messages first";
  if (session.editingQueuedMessageId || session.resendingEdited)
    return "Finish the edit in progress first";
  return undefined;
}

/** True when the chat changed provider conversation after `index`. */
function movedAfter(session: Session, index: number): boolean {
  const harness = session.blocks[index]?.turnModel?.harness;
  return session.blocks.slice(index).some(
    (block) =>
      block.role === "handoff" ||
      (block.role === "user" &&
        !!block.turnModel?.harness &&
        !!harness &&
        block.turnModel.harness !== harness),
  ) || (!!harness && harness !== session.harness);
}

/** Claude Code and Codex rewind to a recorded boundary, so they need one. */
function needsBoundary(harness: HarnessId): boolean {
  return harness === "claude" || harness === "codex";
}

export function forkPlan(
  session: Session,
  turnStart: number,
  turnEnd: number,
): ForkPlan {
  const kind = harnessCan(session.harness, "fork");
  if (kind !== "atTurn") {
    return {
      mode: "approximate",
      reason: "This harness cannot copy its own conversation",
    };
  }
  if (!session.providerSessionId) {
    return {
      mode: "approximate",
      reason: "This chat has no conversation to copy yet",
    };
  }
  if (movedAfter(session, turnStart)) {
    return {
      mode: "approximate",
      reason: "The chat moved to another provider after this turn",
    };
  }
  const last = turnEnd >= session.blocks.length;
  if (session.harness === "codex") {
    // `lastTurnId` is inclusive: the fork keeps this turn and its reply.
    const turnId = session.blocks[turnStart]?.providerTurnId;
    if (last) return { mode: "native", harness: "codex" };
    if (!turnId) {
      return {
        mode: "approximate",
        reason: "This turn's place in the conversation is not known",
      };
    }
    return { mode: "native", harness: "codex", lastTurnId: turnId };
  }
  if (session.harness === "claude") {
    if (last) return { mode: "native", harness: "claude" };
    // The next prompt followed the entry this turn ended on: cut there.
    const at = session.blocks[turnEnd]?.providerTurnId;
    if (!at) {
      return {
        mode: "approximate",
        reason: "This turn's place in the conversation is not known",
      };
    }
    return { mode: "native", harness: "claude", at };
  }
  return {
    mode: "approximate",
    reason: "This harness cannot copy its own conversation",
  };
}

/**
 * What can be done at this prompt, each with the reason when it cannot. Null
 * when the block is not a prompt the user sent.
 */
export function rewindOptions(
  session: Session,
  blockId: string,
  context: RewindContext = {},
): RewindOptions | null {
  const index = session.blocks.findIndex((block) => block.id === blockId);
  if (index < 0) return null;
  const block = session.blocks[index];
  if (!isRewindablePrompt(session, block)) return null;
  const turnStart = turnStartIndex(session.blocks, index);
  const turnEnd = turnEndIndex(session, turnStart);
  const isLastTurn = turnEnd >= session.blocks.length;
  const start = session.blocks[turnStart];
  const blocked = sessionRewindBlocker(session);

  const chat = ((): RewindOptions["chat"] => {
    if (blocked) return { enabled: false, reason: blocked };
    const kind = harnessCan(session.harness, "rewind");
    if (kind === "none") {
      return {
        enabled: false,
        reason: "This harness cannot take back its conversation",
      };
    }
    if (kind === "lastTurn" && !isLastTurn) {
      return {
        enabled: false,
        reason: "This harness can take back only its last turn",
      };
    }
    if (movedAfter(session, turnStart)) {
      return {
        enabled: false,
        reason: "The chat moved to another provider after this turn",
      };
    }
    if (needsBoundary(session.harness) && !start.providerTurnId) {
      return {
        enabled: false,
        reason:
          "This turn's place in the conversation is not known: it was sent before a restart or a compaction",
      };
    }
    return {
      enabled: true,
      ...(start.providerTurnId ? { providerTurnId: start.providerTurnId } : {}),
    };
  })();

  const files = ((): RewindOptions["files"] => {
    if (session.busy) return { enabled: false, reason: "Stop the current turn first" };
    if (context.sharedCheckout) {
      return {
        enabled: false,
        reason: "Another chat is working in this folder",
      };
    }
    if (!start.checkpointTurnId) {
      return {
        enabled: false,
        reason: "No checkpoint was taken before this turn",
      };
    }
    return { enabled: true, checkpointTurnId: start.checkpointTurnId };
  })();

  const plan = forkPlan(session, turnStart, turnEnd);
  const fork: RewindOptions["fork"] = session.busy
    ? { enabled: false, reason: "Stop the current turn first", plan }
    : { enabled: true, plan };

  const laterPrompts = session.blocks
    .slice(turnEnd)
    .filter((entry) => isRewindablePrompt(session, entry)).length;
  return {
    blockId,
    turnStart,
    turnEnd,
    isLastTurn,
    laterPrompts,
    chat,
    files,
    fork,
  };
}

/** The transcript once the chat is rewound to before the turn. */
export function blocksBeforeTurn(session: Session, turnStart: number): Block[] {
  return session.blocks.slice(0, turnStart);
}

/** The prompt that was taken back, to put in the composer again. */
export function rewoundPrompt(
  session: Session,
  turnStart: number,
): { text: string; attachments: NonNullable<Block["attachments"]> } {
  const block = session.blocks[turnStart];
  return {
    text: block?.text ?? "",
    attachments: block?.attachments ?? [],
  };
}

/**
 * The transcript a fork starts with: everything up to the end of the turn,
 * with new block ids. Live state (approvals, streaming) and the source's own
 * provider and checkpoint ids are left out: they belong to the source.
 */
export function forkBlocks(
  session: Session,
  turnEnd: number,
  newId: () => string = () => crypto.randomUUID(),
): Block[] {
  return session.blocks
    .slice(0, turnEnd)
    .filter(
      (block) =>
        !block.draft &&
        !(block.role === "approval" && !block.approval?.decided),
    )
    .map((block) => {
      const {
        providerTurnId: _turn,
        checkpointTurnId: _checkpoint,
        streaming: _streaming,
        approval,
        ...rest
      } = block;
      return {
        ...rest,
        id: newId(),
        ...(approval?.decided ? { approval } : {}),
      } as Block;
    });
}

/** The fork's title: the source's, marked, and marked again if approximate. */
export function forkTitle(title: string | undefined, approximate: boolean): string {
  const base = (title ?? "").trim() || "Chat";
  return `${base} (fork${approximate ? ", approximate" : ""})`;
}
