import {
  turnWrittenPaths,
  turnWroteFiles,
} from "../../file-cards/model/documentFiles";
import {
  isPreviewLive,
  previewForSession,
  previewOutput,
  previewProcess,
  type PreviewProbeResult,
} from "../../app-preview/model/previewStore";
import { invoke } from "@tauri-apps/api/core";
import type { Block } from "../../sessions/model/session";
import {
  evaluateVerify,
  markOutput,
  MAX_AUTO_SENDS,
  outputSince,
  type OutputMark,
  type VerifyResult,
} from "./verify";
import {
  checkServedScripts,
  parseWithAcorn,
  type ScriptFetch,
  type ScriptParseError,
} from "./scriptCheck";

/**
 * #38a: the turn watch, the results, and the automatic loop.
 *
 * - A turn starts when a chat turns busy. If a preview runs then, the output
 *   is marked, so only what the turn caused is read.
 * - A turn ends when the chat is idle again. If it changed files, MonoCode
 *   verifies. A chat that had no preview at the start is not checked.
 * - With the chat's auto switch on, a failure is sent to the agent at most
 *   `MAX_AUTO_SENDS` times in a row. A pass, or a turn the user sends
 *   themselves, resets the count.
 */

export type VerifyTurnSession = {
  id: string;
  busy?: boolean;
  blocks: readonly Block[];
};

type TurnStart = {
  turnKey: string;
  mark: OutputMark;
  processId: string;
};

type ChatState = {
  result?: VerifyResult;
  /** Running a check now. */
  checking?: boolean;
  /** Send failures to the agent by itself. Off by default (rule 9). */
  auto: boolean;
  /** Reports sent by the loop since the last pass or user turn. */
  autoSends: number;
  /** The next turn to start is one the loop sent. */
  autoTurnPending?: boolean;
};

export type VerifyDeps = {
  probe(url: string): Promise<PreviewProbeResult>;
  /** Loopback only, no redirects, like the probe. */
  fetchScript(url: string): Promise<ScriptFetch>;
  parseScript(text: string): Promise<ScriptParseError | null>;
  now(): number;
};

const DEFAULT_DEPS: VerifyDeps = {
  probe: (url) => invoke<PreviewProbeResult>("preview_probe", { url }),
  fetchScript: (url) => invoke<ScriptFetch>("preview_fetch_script", { url }),
  parseScript: parseWithAcorn,
  now: () => Date.now(),
};

let deps = DEFAULT_DEPS;
const chats = new Map<string, ChatState>();
const starts = new Map<string, TurnStart>();
const busy = new Map<string, boolean>();
const listeners = new Set<() => void>();
let version = 0;

export function setVerifyDepsForTest(next: Partial<VerifyDeps> | null): void {
  resetVerifyForTest();
  deps = next ? { ...DEFAULT_DEPS, ...next } : DEFAULT_DEPS;
}

export function resetVerifyForTest(): void {
  chats.clear();
  starts.clear();
  busy.clear();
  listeners.clear();
  version = 0;
}

function changed(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function subscribeVerify(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function verifyVersion(): number {
  return version;
}

function chat(sessionId: string): ChatState {
  let state = chats.get(sessionId);
  if (!state) {
    state = { auto: false, autoSends: 0 };
    chats.set(sessionId, state);
  }
  return state;
}

export function verifyState(sessionId: string): Readonly<ChatState> {
  return chats.get(sessionId) ?? { auto: false, autoSends: 0 };
}

export function setVerifyAuto(sessionId: string, auto: boolean): void {
  const state = chat(sessionId);
  state.auto = auto;
  state.autoSends = 0;
  changed();
}

/** The id of the user block that opened the latest turn. */
export function latestTurnKey(blocks: readonly Block[]): string | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1)
    if (blocks[index].role === "user") return blocks[index].id;
  return undefined;
}

/** The blocks of the latest turn, after its user block. */
export function latestTurnBlocks(blocks: readonly Block[]): readonly Block[] {
  for (let index = blocks.length - 1; index >= 0; index -= 1)
    if (blocks[index].role === "user") return blocks.slice(index + 1);
  return blocks;
}

/** A turn began: mark the preview's output, if one runs. */
export function noteTurnStart(session: VerifyTurnSession): void {
  const state = chat(session.id);
  if (state.autoTurnPending) state.autoTurnPending = false;
  else state.autoSends = 0;
  const preview = previewForSession(session.id);
  // launch.json's `autoVerify: false` turns the check off for that server.
  if (!isPreviewLive(preview) || !preview || preview.candidate.autoVerify === false) {
    starts.delete(session.id);
    return;
  }
  starts.set(session.id, {
    turnKey: latestTurnKey(session.blocks) ?? `turn-${deps.now()}`,
    mark: markOutput(previewOutput(session.id)),
    processId: preview.processId,
  });
}

/**
 * A turn ended. Returns the result when it was checked, and whether the loop
 * should send the report now.
 */
export async function noteTurnEnd(
  session: VerifyTurnSession,
): Promise<{ result: VerifyResult; autoSend: boolean } | undefined> {
  const start = starts.get(session.id);
  starts.delete(session.id);
  if (!start) return undefined;
  if (!turnWroteFiles(latestTurnBlocks(session.blocks))) return undefined;
  const turnKey = latestTurnKey(session.blocks) ?? start.turnKey;
  const written = turnWrittenPaths(
    latestTurnBlocks(session.blocks),
    previewForSession(session.id)?.workCwd,
  );
  const result = await verifyNow(
    session.id,
    turnKey,
    start.mark,
    start.processId,
    written,
  );
  if (!result) return undefined;
  const state = chat(session.id);
  const autoSend = !result.ok && state.auto && state.autoSends < MAX_AUTO_SENDS;
  return { result, autoSend };
}

/**
 * Run the checks now. `mark` limits the output read to what came after it;
 * without one, the whole held output is read. `written` are the files the
 * turn changed; its scripts are fetched and parsed.
 */
export async function verifyNow(
  sessionId: string,
  turnKey: string,
  mark?: OutputMark,
  processId?: string,
  written: readonly string[] = [],
): Promise<VerifyResult | undefined> {
  const preview = previewForSession(sessionId);
  if (!preview) return undefined;
  // A restart between the start and the end replaced the process: its new
  // output is all new.
  const sameProcess = !processId || processId === preview.processId;
  const process = previewProcess(sessionId);
  const output = previewOutput(sessionId);
  const alive =
    isPreviewLive(preview) &&
    (!process || process.status === "starting" || process.status === "running");
  const state = chat(sessionId);
  state.checking = true;
  changed();
  try {
    const http = alive && preview.url
      ? await deps.probe(preview.url).catch(
          (error: unknown): PreviewProbeResult => ({
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      : preview.url
        ? { error: "The server is not running" }
        : undefined;
    const scripts =
      alive && preview.url && typeof http?.status === "number" && written.length
        ? await checkServedScripts(written, preview.runCwd, preview.url, {
            fetchScript: deps.fetchScript,
            parseScript: deps.parseScript,
          }).catch(() => undefined)
        : undefined;
    const result = evaluateVerify({
      sessionId,
      turnKey,
      alive,
      ...(!alive
        ? {
            exitDetail:
              process?.status === "exited" && process.exitCode != null
                ? `The server exited with code ${process.exitCode}`
                : process?.status === "failed"
                  ? `The server failed: ${process.error ?? "no reason given"}`
                  : "The server has stopped",
          }
        : {}),
      newOutput: outputSince(sameProcess ? mark : undefined, output),
      ...(preview.url ? { url: preview.url } : {}),
      ...(http ? { http } : {}),
      ...(scripts ? { scripts } : {}),
      at: deps.now(),
    });
    state.result = result;
    if (result.ok) state.autoSends = 0;
    return result;
  } finally {
    state.checking = false;
    changed();
  }
}

/** The loop is about to send a report as the next turn. */
export function noteAutoSend(sessionId: string): void {
  const state = chat(sessionId);
  state.autoSends += 1;
  state.autoTurnPending = true;
  changed();
}

/** The report did not go out: the next turn is the user's own. */
export function cancelAutoSend(sessionId: string): void {
  const state = chat(sessionId);
  state.autoTurnPending = false;
  changed();
}

/**
 * Busy edges across every chat, from one render's list. Returns the chats
 * whose turn started and ended since the last call.
 */
export function turnEdges(sessions: readonly VerifyTurnSession[]): {
  started: VerifyTurnSession[];
  ended: VerifyTurnSession[];
  gone: string[];
} {
  const started: VerifyTurnSession[] = [];
  const ended: VerifyTurnSession[] = [];
  const present = new Set<string>();
  for (const session of sessions) {
    present.add(session.id);
    const now = session.busy === true;
    const before = busy.get(session.id);
    busy.set(session.id, now);
    if (before === undefined) {
      // First sight: a chat already mid-turn has no mark; nothing to compare.
      continue;
    }
    if (!before && now) started.push(session);
    else if (before && !now) ended.push(session);
  }
  const gone: string[] = [];
  for (const id of [...busy.keys()])
    if (!present.has(id)) {
      busy.delete(id);
      starts.delete(id);
      chats.delete(id);
      gone.push(id);
    }
  return { started, ended, gone };
}

/** The result for the latest turn of this chat, if it was checked. */
export function latestVerify(
  sessionId: string,
  blocks: readonly Block[],
): VerifyResult | undefined {
  const result = chats.get(sessionId)?.result;
  if (!result) return undefined;
  return result.turnKey === latestTurnKey(blocks) ? result : undefined;
}
