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
  notifyChatContext,
  reportPreamble,
} from "./chatContext";
import {
  buildPreamble,
  nativePreambleText,
  preambleBlock,
  preambleBlockOverhead,
  preambleBudget,
  preambleWindow,
  type MessageBlockKind,
  type PreamblePart,
  type PreamblePartId,
} from "./preamble";
import {
  appReceiptKey,
  conversationGiven,
  forgetAppReceipt,
  forgetPreamble,
  instructionsStale,
  preambleDue,
  recordInstructions,
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
 *   for a harness with no native channel: on the first turn of each provider
 *   conversation and after a compaction MonoCode saw, never because the
 *   text changed.
 *
 * Finding 2.2 (13 Oct, the user's decision): changed instructions apply to
 * new chats only. Once a conversation has started, instruction content
 * (your instructions, project notes, memory) is never sent into it again by
 * message. The chat records a hash of the instructions and notes it started
 * with, and shows a line when they changed since. MonoCode's own parts (app
 * access, the preview status line) are not instructions: they still reach a
 * running chat when new or changed, in a note that says what it is.
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
 * summary. A native channel keeps the instructions (Claude Code's system
 * prompt survives it, session 9 check 2), so only MonoCode's own parts go
 * again. Without one, the note went in a message and is gone, so the whole
 * note goes again. The first prompt after a restart only counts what is
 * there (corner case 16).
 */
function noteCompactions(
  sessionId: string,
  blocks: readonly Block[] | undefined,
  nativeChannel: boolean,
) {
  const count = compactionCount(blocks);
  const seen = seenCompactions.get(sessionId);
  seenCompactions.set(sessionId, count);
  if (seen === undefined || count <= seen) return;
  if (nativeChannel) forgetAppReceipt(sessionId);
  else forgetPreamble(sessionId);
}

/** Instruction content: what changes only reach new chats. */
const INSTRUCTION_IDS: ReadonlySet<PreamblePartId> = new Set([
  "instructions",
  "project-notes",
  "memory",
]);

/**
 * The hash a chat records at start and compares later: your instructions and
 * the project's notes. Memory is left out, so a memory change alone does not
 * raise the stale line.
 */
export function instructionsHash(parts: readonly PreamblePart[]): string {
  return buildPreamble(
    parts.filter(
      (part) => part.id === "instructions" || part.id === "project-notes",
    ),
    Number.MAX_SAFE_INTEGER,
  ).hash;
}

/** Fit `parts` into the budget as a plain note of `kind`. */
function messageNote(
  parts: readonly PreamblePart[],
  budget: number,
  kind: MessageBlockKind,
) {
  const plain = buildPreamble(
    parts,
    Math.max(0, budget - preambleBlockOverhead(kind)),
    "plain",
  );
  return {
    block: plain.text ? preambleBlock(plain.text, kind) : "",
    included: plain.included,
    omitted: plain.omitted,
  };
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
  const channel = harnessCapabilities(session.harness).instructions;
  const nativeChannel = channel === "system" || channel === "session";
  noteCompactions(session.id, session.blocks, nativeChannel);
  const parts = await gatherPreambleParts(request);
  const appParts = parts.filter((part) => !INSTRUCTION_IDS.has(part.id));
  const start = instructionsHash(parts);
  const app = buildPreamble(appParts, Number.MAX_SAFE_INTEGER).hash;
  const budget = preambleBudget(
    preambleWindow(session.harness, modelBudgetWindow(session.model)),
  );
  const built = buildPreamble(parts, budget);
  const firstTurn = !session.providerSessionId;
  const stale =
    !firstTurn &&
    instructionsStale(session.id, session.providerSessionId, start);
  const report = {
    chars: built.chars,
    budget: built.budget,
    included: built.included,
    omitted: built.omitted,
    overBudget: built.overBudget,
    stale,
    at: Date.now(),
  };

  let preambleFile: string | undefined;
  let developerInstructions: string | undefined;
  if (built.text && channel === "system") {
    preambleFile = await safe(
      () =>
        invoke<string>("session_preamble_write", {
          sessionId: session.id,
          text: nativePreambleText(built.text),
        }),
      undefined,
    );
  } else if (built.text && channel === "session") {
    developerInstructions = nativePreambleText(built.text);
  }
  const native = !!(preambleFile || developerInstructions);
  // The whole text goes when this provider conversation starts: natively
  // when it can, else as the note. A harness with no native channel also
  // sends the note to a conversation that has not had it (a new one, or one
  // compacted), never because the text changed. A Claude Code chat whose
  // launch file failed gets the note on its first turn only.
  const startsNow = firstTurn
    ? true
    : !nativeChannel &&
      !conversationGiven(session.id, session.providerSessionId);
  const fullByMessage = startsNow && !native && !!built.text;
  // MonoCode's own parts reach a running chat when new or changed.
  const appByMessage =
    !startsNow &&
    appParts.length > 0 &&
    preambleDue(appReceiptKey(session.id), session.providerSessionId, app);

  let messageBlock = "";
  let sent: typeof report = report;
  if (fullByMessage || appByMessage) {
    const note = fullByMessage
      ? messageNote(parts, budget, "current")
      : messageNote(appParts, budget, "app");
    messageBlock = note.block;
    sent = {
      ...report,
      chars: messageBlock.length,
      included: note.included,
      omitted: note.omitted,
      overBudget: messageBlock.length > budget,
    };
  }
  reportPreamble(session.id, {
    ...sent,
    channel: !built.text
      ? "none"
      : fullByMessage
        ? "message"
        : appByMessage
          ? "app"
          : startsNow && native
            ? "native"
            : "unchanged",
  });
  return {
    messageBlock,
    ...(preambleFile ? { preambleFile } : {}),
    ...(developerInstructions ? { developerInstructions } : {}),
    commit: (provider) => {
      recordInstructions(session.id, provider, start, {
        startedNow: startsNow,
        native: nativeChannel,
      });
      recordPreamble(appReceiptKey(session.id), provider, app);
      notifyChatContext();
    },
  };
}

/**
 * Whether the open chat's instructions or project notes changed after its
 * provider conversation started (finding 2.2). Reads the current text, so a
 * save in Settings shows at once, before the next turn.
 */
export async function instructionsStaleNow(
  session: Pick<Session, "id" | "providerSessionId">,
  project: string | undefined,
): Promise<boolean> {
  if (!session.providerSessionId) return false;
  const [global, notes] = await Promise.all([
    safe(() => readGlobalContext("instructions.md"), undefined),
    project
      ? safe(() => readProjectContext(project, "notes.md"), undefined)
      : undefined,
  ]);
  return instructionsStale(
    session.id,
    session.providerSessionId,
    instructionsHash(instructionParts(global?.text, notes?.text)),
  );
}

/** A deleted chat leaves no receipt, switch or launch file behind. */
export function forgetSessionContext(sessionId: string): void {
  forgetPreamble(sessionId);
  forgetChatContext(sessionId);
  seenCompactions.delete(sessionId);
  void invoke("session_preamble_forget", { sessionId }).catch(() => undefined);
}
