import { invoke } from "@tauri-apps/api/core";
import { harnessCapabilities } from "../../../integrations/harness/core/capabilities";
import { modelBudgetWindow } from "../../model-traits/model/modelTraits";
import { memoryDate } from "../../monos/model/monoMemory";
import {
  readGlobalContext,
  readProjectContext,
} from "../../project-context/model/projectContext";
import { instructionParts } from "../../project-context/model/instructions";
import {
  localOnlyCount,
  memoryPart,
} from "../../project-memory/model/projectMemory";
import { previewPreamblePart } from "../../app-preview/model/previewPreamble";
import {
  isLocal,
  sessionLocalityNow,
  type LocalitySession,
} from "../../server-locality/model/locality";
import type { Block, Session } from "../../sessions/model/session";
import {
  chatContextPrefs,
  forgetChatContext,
  reportPreamble,
} from "./chatContext";
import {
  buildPreamble,
  nativePreambleText,
  preambleBlock,
  preambleBlockOverhead,
  preambleBudget,
  preambleWindow,
  type PreamblePart,
} from "./preamble";
import {
  forgetPreamble,
  preambleChanged,
  preambleDue,
  recordPreamble,
} from "./receipts";

/**
 * F2 for a regular session's turn: gather the parts, fit them to the model's
 * budget, and decide the channel.
 *
 * - Native, where the capability table offers it (Claude Code's
 *   `--append-system-prompt-file`, Codex's `developerInstructions`). The
 *   adapter applies it only when a new conversation starts, because Claude
 *   Code keeps the first system prompt on `--resume` and Codex ignores new
 *   developer instructions on a loaded thread.
 * - A plain note in the user's voice ahead of the message (`preambleBlock`),
 *   for every other harness and for every change after a conversation has
 *   started. Finding 2.2: it uses no system-like tags. A receipt per provider session
 *   means the text goes once, and again only when it changes, the provider
 *   session changes, or a compaction is seen.
 *
 * Monos keep their own preamble; this is for regular sessions.
 */

export type PreambleSession = LocalitySession &
  Pick<Session, "id" | "harness" | "model" | "providerSessionId"> & {
    blocks?: readonly Block[];
  };

export type PreambleRequest = {
  session: PreambleSession;
  /** The project the session belongs to: its root folder. */
  project: string | undefined;
  /** The `<monocode_app>` block when this thread has app access. */
  operatorBlock?: string;
  /** A slash command must stay first in the message. */
  commandFirst: boolean;
};

export type PreparedPreamble = {
  /** Text to add to the message, already wrapped. Empty when none is due. */
  messageBlock: string;
  /** For Claude Code: the file to pass at launch. */
  preambleFile?: string;
  /** For Codex: developer instructions on thread/start. */
  developerInstructions?: string;
  /** Call once the provider accepted the turn. */
  commit(providerSessionId: string | undefined): void;
};

const NOTHING: PreparedPreamble = { messageBlock: "", commit: () => {} };

/** Status rows that mean the provider's context was compacted. */
const COMPACTED = /\bcompact(?:ed|ing|ion)\b/i;

export function compactionCount(blocks: readonly Block[] | undefined): number {
  if (!blocks) return 0;
  let count = 0;
  for (const block of blocks) {
    if (block.role === "user" || block.role === "assistant") continue;
    if (COMPACTED.test(block.text ?? "")) count++;
  }
  return count;
}

const seenCompactions = new Map<string, number>();

/**
 * A compaction MonoCode can see restarts the provider's context from a
 * summary, so the next turn sends the preamble again.
 */
function noteCompactions(
  sessionId: string,
  blocks: readonly Block[] | undefined,
) {
  const count = compactionCount(blocks);
  const seen = seenCompactions.get(sessionId);
  seenCompactions.set(sessionId, count);
  if (seen !== undefined && count > seen) forgetPreamble(sessionId);
}

async function safe<T>(load: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await load();
  } catch {
    return fallback;
  }
}

/** The parts for this session, before the budget. */
export async function gatherPreambleParts(
  request: PreambleRequest,
  today = memoryDate(),
): Promise<PreamblePart[]> {
  const { session, project } = request;
  const memoryOff = chatContextPrefs(session.id).memoryOff === true;
  const [global, notes, memory] = await Promise.all([
    safe(() => readGlobalContext("instructions.md"), undefined),
    project
      ? safe(() => readProjectContext(project, "notes.md"), undefined)
      : undefined,
    project && !memoryOff
      ? safe(() => readProjectContext(project, "MEMORY.md"), undefined)
      : undefined,
  ]);
  const parts = instructionParts(global?.text, notes?.text);
  if (request.operatorBlock)
    parts.push({
      id: "operator",
      label: "App access (/operator)",
      text: request.operatorBlock,
      required: true,
    });
  // Asking the harness about its home is needed only when local-only entries
  // are at stake.
  const local =
    !!memory?.text &&
    localOnlyCount(memory.text) > 0 &&
    isLocal(await sessionLocalityNow(session));
  const mem = memory?.text
    ? memoryPart(memory.text, { local, today })
    : undefined;
  if (mem) parts.push(mem);
  // #37: one line for a preview server MonoCode runs for this chat.
  const preview = previewPreamblePart(session.id);
  if (preview) parts.push(preview);
  return parts;
}

export async function prepareSessionPreamble(
  request: PreambleRequest,
): Promise<PreparedPreamble> {
  const { session } = request;
  noteCompactions(session.id, session.blocks);
  const parts = await gatherPreambleParts(request);
  const budget = preambleBudget(
    preambleWindow(session.harness, modelBudgetWindow(session.model)),
  );
  const built = buildPreamble(parts, budget);
  const report = {
    chars: built.chars,
    budget: built.budget,
    included: built.included,
    omitted: built.omitted,
    overBudget: built.overBudget,
    at: Date.now(),
  };
  if (!built.text) {
    // Nothing to tell. A receipt for the empty text means text added later
    // is sent.
    reportPreamble(session.id, { ...report, channel: "none" });
    return {
      ...NOTHING,
      commit: (provider) => recordPreamble(session.id, provider, built.hash),
    };
  }

  const channel = harnessCapabilities(session.harness).instructions;
  const firstTurn = !session.providerSessionId;
  let preambleFile: string | undefined;
  let developerInstructions: string | undefined;
  if (channel === "system") {
    preambleFile = await safe(
      () =>
        invoke<string>("session_preamble_write", {
          sessionId: session.id,
          text: nativePreambleText(built.text),
        }),
      undefined,
    );
  } else if (channel === "session") {
    developerInstructions = nativePreambleText(built.text);
  }
  const native = !!(preambleFile || developerInstructions);
  // A new conversation gets it natively when it can. Anything after that,
  // or a harness with no native channel, gets it in the message when due.
  const byMessage = firstTurn
    ? !native
    : preambleDue(session.id, session.providerSessionId, built.hash);
  // The message channel prints the parts as plain text in a note, fitted to
  // the budget with the note's own lines counted. The receipt keeps the hash
  // of the full text, so a change is seen the same way on every channel.
  let messageBlock = "";
  let sent = report;
  if (byMessage) {
    const kind = preambleChanged(
      session.id,
      session.providerSessionId,
      built.hash,
    )
      ? "changed"
      : "current";
    const plain = buildPreamble(
      parts,
      Math.max(0, budget - preambleBlockOverhead(kind)),
      "plain",
    );
    messageBlock = plain.text ? preambleBlock(plain.text, kind) : "";
    sent = {
      ...report,
      chars: messageBlock.length,
      included: plain.included,
      omitted: plain.omitted,
      overBudget: messageBlock.length > budget,
    };
  }
  reportPreamble(session.id, {
    ...sent,
    channel: byMessage
      ? "message"
      : firstTurn && native
        ? "native"
        : "unchanged",
  });
  return {
    messageBlock,
    ...(preambleFile ? { preambleFile } : {}),
    ...(developerInstructions ? { developerInstructions } : {}),
    commit: (provider) => recordPreamble(session.id, provider, built.hash),
  };
}

/** "Send instructions again": the next turn carries the preamble by message. */
export function resendPreamble(sessionId: string): void {
  forgetPreamble(sessionId);
}

/** A deleted chat leaves no receipt, switch or launch file behind. */
export function forgetSessionContext(sessionId: string): void {
  forgetPreamble(sessionId);
  forgetChatContext(sessionId);
  seenCompactions.delete(sessionId);
  void invoke("session_preamble_forget", { sessionId }).catch(() => undefined);
}
