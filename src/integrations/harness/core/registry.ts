import { withoutFenceFor } from "./noteFence";
import type {
  Block,
  HarnessId,
  TaskListMeta,
  TurnIntent,
} from "../../../features/sessions/model/session";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { GeneratedSessionTitle } from "../../../features/sessions/model/sessionTitle";
import type { PrContent } from "../../../features/source-control/model/gitText";
import { hasLiveCatalog } from "../../../features/sessions/model/models";
import type { UserQuestionReply } from "../../../features/sessions/model/userQuestion";
import type { NativeCommandProvider } from "./nativeCommands";
import type {
  ApprovalDecision,
  CompactContextInput,
  HarnessEvent,
  HarnessMcpServer,
  HarnessSessionInput,
  HarnessToolAccess,
  ListMcpServersInput,
  RewindLastTurnInput,
  RewindLastTurnResult,
  SendTurnInput,
  SteerTurnInput,
} from "./types";
import type { ApprovalOptions } from "../../../features/tool-access/model/networkApproval";
import type { BackgroundItem } from "./background";
import type {
  HarnessSessionRow,
  ImportedHistory,
  ListSessionsInput,
  ReadSessionInput,
} from "../../../features/session-import/model/types";

export type TitleInput = {
  sessionId: string;
  cwd: string;
  message: string;
  providerAccountId?: string;
};

/** One-shot, isolated text generation shared by titles and side questions. */
export type TextPromptInput = {
  cwd: string;
  providerAccountId?: string;
  model?: string;
  modelSettings?: Record<string, string>;
  /** Codex defaults to unsaved threads; false allows resumable side questions. */
  ephemeral?: boolean;
  codexStore?: "mono";
  threadId?: string;
  onThreadId?: (threadId: string) => void;
  intent?: TurnIntent;
  prompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: HarnessEvent) => void;
};

/**
 * Lifecycle contract for a live harness adapter.
 * App.tsx dispatches through the registry instead of harness-specific branches.
 */
export type HarnessAdapter = {
  id: HarnessId;
  /** True when this adapter can run live turns. */
  live: boolean;
  /** False when the harness cannot accept a follow-up while a turn is running. Default: same as live. */
  canSteer?: boolean;
  commands?: NativeCommandProvider;
  sendTurn(input: SendTurnInput): Promise<void>;
  /** Trigger provider-owned compaction outside MonoCode's normal user-turn path. */
  compactContext?(input: CompactContextInput): Promise<void>;
  /** Rewind provider state so the last user turn can be replaced. */
  rewindLastTurn?(input: RewindLastTurnInput): Promise<RewindLastTurnResult>;
  steerTurn(input: SteerTurnInput): Promise<void>;
  cancelTurn(sessionId: string): Promise<void>;
  respondApproval(
    sessionId: string,
    requestId: number,
    decision: ApprovalDecision,
    /**
     * Extra choices on an allow. Only Codex reads `networkAmendment`, and
     * only when it matches a host rule Codex proposed; others ignore it.
     */
    options?: ApprovalOptions,
  ): void;
  respondQuestion?(
    sessionId: string,
    requestId: number,
    reply: UserQuestionReply,
  ): void;
  /** Keep a timed question open once the user starts answering it. */
  keepQuestionOpen?(sessionId: string, requestId: number): void;
  /**
   * Replace a running session's per-tool rules at once, so a rule set in the
   * middle of a turn answers the next request. Each turn start also passes
   * the rules as `toolAccess`; this covers the time in between. A no-op for
   * a session with no live process.
   */
  setToolAccess?(sessionId: string, access?: HarnessToolAccess): void;
  /** Kill the child but keep resume state for later rebind. */
  stopSession(sessionId: string): Promise<void>;
  /** Drop resume state and kill the child (delete, harness switch, idle detach). */
  forgetSession(sessionId: string): Promise<void>;
  /** Seed resume state from a restored MonoCode session. */
  bindSession(
    threadId: string,
    providerSessionId: string,
    cwd: string,
    providerAccountId?: string,
  ): void;
  /** Seed provider task state from a restored session's persisted panels. */
  restoreTaskLists?(threadId: string, lists: TaskListMeta[]): void;
  /** Refresh the model catalog overlay when supported. */
  refreshCatalog?(): Promise<void>;
  /** Optional LLM tab title for the first turn. */
  generateTitle?(input: TitleInput): Promise<GeneratedSessionTitle | null>;
  /** Optional LLM commit message from staged changes. */
  generateCommitMessage?(
    cwd: string,
    signal?: AbortSignal,
    paths?: readonly string[],
  ): Promise<string>;
  /** Optional LLM pull request title/body from branch diff context. */
  generatePrContent?(
    cwd: string,
  ): Promise<(PrContent & { base: string; head: string }) | null>;
  /** Optional LLM branch name from a user message. */
  generateBranchName?(cwd: string, message: string): Promise<string | null>;
  /** Optional warmup for text-generation backends. */
  warmupText?(cwd: string): Promise<void>;
  /** Run an isolated, read-only prompt without mutating the main session. */
  runTextPrompt?(input: TextPromptInput): Promise<string>;
  /** Stop an isolated text-generation backend. */
  stopTextPrompt?(): Promise<void>;
  /**
   * The MCP servers a session's own harness reports, for harnesses whose
   * session can run with a configuration the app cannot read from disk.
   */
  listMcpServers?(input: ListMcpServersInput): Promise<HarnessMcpServer[]>;
  /**
   * Stops one item the harness reports running beside the turn, by its id.
   * Resolves false when the item or the session is no longer live.
   */
  stopBackgroundTask?(sessionId: string, itemId: string): Promise<boolean>;
  /**
   * What the harness runs beside the turn, for harnesses that are asked
   * rather than reporting it as events. Null when the call is unavailable.
   */
  listBackgroundTasks?(sessionId: string): Promise<BackgroundItem[] | null>;
  /**
   * Copies the source chat's conversation into a new one for `newSessionId`,
   * up to `boundary` when given (the harness's own turn or entry id). Returns
   * the copy's provider id when the harness makes it now; otherwise the new
   * chat binds its own id on its first start.
   */
  forkSession?(input: {
    source: HarnessSessionInput;
    providerSessionId: string;
    newSessionId: string;
    boundary?: string;
  }): Promise<{ providerSessionId?: string }>;
  /**
   * #45: the sessions the harness recorded for a folder, outside MonoCode
   * or not, newest first. Read only.
   */
  listSessions?(input: ListSessionsInput): Promise<HarnessSessionRow[]>;
  /** #45: a listed session's earlier turns, as text, where the harness can replay them. */
  readSessionTurns?(input: ReadSessionInput): Promise<ImportedHistory>;
};

const adapters = new Map<HarnessId, HarnessAdapter>();

/**
 * After a turn settles, keep the child warm for follow-ups, then park it.
 * Resume state stays, so the next prompt respawns instead of starting over.
 */
export const HARNESS_IDLE_PARK_MS = 3 * 60_000;

/**
 * Each warm child is a CLI process of a few hundred MB, plus its MCP servers.
 * Past `limit` idle ones, the least recently settled is parked early, never
 * one `keep` claims (the conversation on screen) unless the limit is zero.
 * Running turns are not idle, so they never count.
 */
export type HarnessIdleParkPolicy = {
  limit: () => number;
  keep: (sessionId: string) => boolean;
};

let idleParkPolicy: HarnessIdleParkPolicy = {
  limit: () => Number.POSITIVE_INFINITY,
  keep: () => false,
};
let idleLimitCheck: ReturnType<typeof setTimeout> | undefined;

/** Map order is settle order: the first entry has been idle longest. */
const idleParkTimers = new Map<
  string,
  { harness: HarnessId; timer: ReturnType<typeof setTimeout> }
>();
const sessionOperationTails = new Map<string, Promise<void>>();
const sessionSteerTails = new Map<string, Promise<void>>();
const activeTurnSessions = new Set<string>();
/** Sessions whose running turn was stopped, for its `turn.completed`. */
const stoppedTurnSessions = new Set<string>();

type TurnObserver = (sessionId: string, event: HarnessEvent) => void;
const turnObservers = new Set<TurnObserver>();

/**
 * Hears every `turn.completed`, even one the chat drops: after Stop the app
 * ignores the rest of a turn's events, but the activity log still needs its
 * end (Mac test 2.2). Returns the stop function.
 */
export function observeHarnessTurns(observer: TurnObserver): () => void {
  turnObservers.add(observer);
  return () => {
    turnObservers.delete(observer);
  };
}

function completeTurn(
  sessionId: string,
  onEvent: (event: HarnessEvent) => void,
  status: "completed" | "interrupted" | "failed",
): void {
  const event: HarnessEvent = { type: "turn.completed", status };
  try {
    onEvent(event);
  } catch {
    // The chat's handler failing must not hide the end from the log.
  }
  for (const observer of turnObservers) {
    try {
      observer(sessionId, event);
    } catch {
      // One observer failing must not stop the others.
    }
  }
}

function queueSessionOperation<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = sessionOperationTails.get(sessionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  sessionOperationTails.set(sessionId, settled);
  void settled.then(() => {
    if (sessionOperationTails.get(sessionId) === settled) {
      sessionOperationTails.delete(sessionId);
    }
  });
  return current;
}

function queueSteerOperation<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previousSteer = sessionSteerTails.get(sessionId) ?? Promise.resolve();
  // A live turn must remain steerable while its long-running send is pending.
  // Other provider-state operations still form a barrier for the steer.
  const barrier = activeTurnSessions.has(sessionId)
    ? Promise.resolve()
    : (sessionOperationTails.get(sessionId) ?? Promise.resolve());
  const current = Promise.all([
    previousSteer.catch(() => undefined),
    barrier.catch(() => undefined),
  ]).then(operation);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  sessionSteerTails.set(sessionId, settled);
  void settled.then(() => {
    if (sessionSteerTails.get(sessionId) === settled) {
      sessionSteerTails.delete(sessionId);
    }
  });
  return current;
}

function cancelIdlePark(sessionId: string): void {
  const idle = idleParkTimers.get(sessionId);
  if (idle) clearTimeout(idle.timer);
  idleParkTimers.delete(sessionId);
}

function scheduleIdlePark(harness: HarnessId, sessionId: string): void {
  cancelIdlePark(sessionId);
  idleParkTimers.set(sessionId, {
    harness,
    timer: setTimeout(() => {
      idleParkTimers.delete(sessionId);
      void stopHarnessSession(harness, sessionId);
    }, HARNESS_IDLE_PARK_MS),
  });
  // Checked once the settling operation has left the queue, so a session
  // with a follow-up already queued is told apart from the one finishing.
  if (idleLimitCheck === undefined) {
    idleLimitCheck = setTimeout(enforceHarnessIdleLimit, 0);
  }
}

export function configureHarnessIdlePark(policy: HarnessIdleParkPolicy) {
  idleParkPolicy = policy;
}

/** Park the longest-idle children past the limit; also run when it drops. */
export function enforceHarnessIdleLimit(): void {
  clearTimeout(idleLimitCheck);
  idleLimitCheck = undefined;
  const limit = Math.max(0, idleParkPolicy.limit());
  let excess = idleParkTimers.size - limit;
  for (const [sessionId, { harness }] of [...idleParkTimers]) {
    if (excess <= 0) return;
    if (sessionOperationTails.has(sessionId)) continue;
    if (limit > 0 && idleParkPolicy.keep(sessionId)) continue;
    excess -= 1;
    void stopHarnessSession(harness, sessionId);
  }
}

/** Test seam. */
export function resetHarnessIdlePark(): void {
  for (const { timer } of idleParkTimers.values()) clearTimeout(timer);
  idleParkTimers.clear();
  clearTimeout(idleLimitCheck);
  idleLimitCheck = undefined;
  idleParkPolicy = {
    limit: () => Number.POSITIVE_INFINITY,
    keep: () => false,
  };
}

export function registerHarness(adapter: HarnessAdapter): void {
  adapters.set(adapter.id, adapter);
}

export function getHarness(id: HarnessId): HarnessAdapter | undefined {
  return adapters.get(id);
}

export function requireHarness(id: HarnessId): HarnessAdapter {
  const adapter = adapters.get(id);
  if (!adapter) {
    throw new Error(`No harness adapter registered for "${id}"`);
  }
  return adapter;
}

export function isLiveHarness(id: HarnessId): boolean {
  return adapters.get(id)?.live === true;
}

export function listHarnesses(): HarnessAdapter[] {
  return [...adapters.values()];
}

/**
 * Tells computer use whether this chat's turn is a plan turn, so its MCP
 * server runs only look-only tools then, on every harness (security review
 * S6). Never throws. Returns false when the mark did not take.
 */
async function markPlanTurn(chatId: string, plan: boolean): Promise<boolean> {
  try {
    await invoke("computer_use_set_plan", { chatId, plan });
    return true;
  } catch {
    return false;
  }
}

export function sendHarnessTurn(input: SendTurnInput & { harness: HarnessId }) {
  return queueSessionOperation(input.sessionId, async () => {
    const adapter = requireHarness(input.harness);
    if (!adapter.live) {
      throw new Error(`${input.harness} is not connected yet`);
    }
    cancelIdlePark(input.sessionId);
    const controlled = typeof isTauri === "function" && isTauri();
    if (controlled)
      await invoke("control_authorize_turn", {
        sessionId: input.sessionId,
        cwd: input.cwd,
        appAccess: input.appAccess === true,
      });
    // A plan turn whose mark did not take does not run: computer use would
    // not hold its actions back (security review T7).
    if (
      controlled &&
      !(await markPlanTurn(input.sessionId, input.intent === "plan")) &&
      input.intent === "plan"
    ) {
      await invoke("control_turn_finished", { sessionId: input.sessionId });
      throw new Error(
        "MonoCode could not hold computer use back for this plan turn, so it did not start. Try again.",
      );
    }
    activeTurnSessions.add(input.sessionId);
    stoppedTurnSessions.delete(input.sessionId);
    // The one place a turn's end is announced, for every adapter: where the
    // send settles (Claude's finishActiveTurn, Codex's turn/completed, any
    // other adapter's return).
    let status: "completed" | "interrupted" | "failed" = "completed";
    try {
      await adapter.sendTurn({
        ...input,
        onEvent: (event) => {
          if (event.type === "session.error") status = "failed";
          input.onEvent(event);
        },
        onAccepted: () => {
          input.onEvent({ type: "turn.ready" });
          input.onAccepted?.();
        },
      });
    } catch (error) {
      status = "failed";
      throw error;
    } finally {
      activeTurnSessions.delete(input.sessionId);
      if (stoppedTurnSessions.delete(input.sessionId)) status = "interrupted";
      completeTurn(input.sessionId, input.onEvent, status);
      if (controlled) {
        await markPlanTurn(input.sessionId, false);
        await invoke("control_turn_finished", { sessionId: input.sessionId });
      }
      scheduleIdlePark(input.harness, input.sessionId);
    }
  });
}

export function canCompactHarnessContext(id: HarnessId): boolean {
  const adapter = adapters.get(id);
  return adapter?.live === true && adapter.compactContext != null;
}

export function compactHarnessContext(
  input: CompactContextInput & { harness: HarnessId },
): Promise<void> {
  return queueSessionOperation(input.sessionId, async () => {
    const adapter = requireHarness(input.harness);
    if (!adapter.live) {
      throw new Error(`${input.harness} is not connected yet`);
    }
    if (!adapter.compactContext) {
      throw new Error(`${input.harness} does not support manual compaction`);
    }
    cancelIdlePark(input.sessionId);
    try {
      await adapter.compactContext(input);
    } finally {
      scheduleIdlePark(input.harness, input.sessionId);
    }
  });
}

export function canSteerHarness(id: HarnessId): boolean {
  const adapter = adapters.get(id);
  if (!adapter?.live) return false;
  return adapter.canSteer !== false;
}

export function canRewindHarnessLastTurn(id: HarnessId): boolean {
  const adapter = adapters.get(id);
  return adapter?.live === true && adapter.rewindLastTurn != null;
}

export function rewindHarnessLastTurn(
  input: RewindLastTurnInput & { harness: HarnessId },
): Promise<RewindLastTurnResult> {
  return queueSessionOperation(input.sessionId, async () => {
    const adapter = requireHarness(input.harness);
    if (!adapter.rewindLastTurn) {
      throw new Error(
        `${input.harness} does not support editing the last message`,
      );
    }
    cancelIdlePark(input.sessionId);
    try {
      return await adapter.rewindLastTurn(input);
    } finally {
      scheduleIdlePark(input.harness, input.sessionId);
    }
  });
}

export function steerHarnessTurn(
  input: SteerTurnInput & { harness: HarnessId },
): Promise<void> {
  return queueSteerOperation(input.sessionId, async () => {
    const adapter = requireHarness(input.harness);
    if (!adapter.live) {
      throw new Error(`${input.harness} is not connected yet`);
    }
    cancelIdlePark(input.sessionId);
    // MonoCode never adds its note to guidance mid-turn, so no guidance may
    // carry the note's fence lines (security review K1).
    await adapter.steerTurn({
      ...input,
      text: withoutFenceFor(input.sessionId, input.text),
    });
  });
}

export async function cancelHarnessTurn(
  harness: HarnessId,
  sessionId: string,
): Promise<void> {
  const adapter = getHarness(harness);
  if (!adapter?.live) return;
  cancelIdlePark(sessionId);
  if (activeTurnSessions.has(sessionId)) stoppedTurnSessions.add(sessionId);
  await adapter.cancelTurn(sessionId);
  scheduleIdlePark(harness, sessionId);
}

export function respondHarnessApproval(
  harness: HarnessId,
  sessionId: string,
  requestId: number,
  decision: ApprovalDecision,
  options?: ApprovalOptions,
): void {
  const adapter = getHarness(harness);
  if (!adapter) return;
  if (options) adapter.respondApproval(sessionId, requestId, decision, options);
  else adapter.respondApproval(sessionId, requestId, decision);
}

export function respondHarnessQuestion(
  harness: HarnessId,
  sessionId: string,
  requestId: number,
  reply: UserQuestionReply,
): void {
  getHarness(harness)?.respondQuestion?.(sessionId, requestId, reply);
}

/** Hand a session's changed per-tool rules to its running harness, if any. */
export function setHarnessToolAccess(
  harness: HarnessId,
  sessionId: string,
  access?: HarnessToolAccess,
): void {
  getHarness(harness)?.setToolAccess?.(sessionId, access);
}

export function keepHarnessQuestionOpen(
  harness: HarnessId,
  sessionId: string,
  requestId: number,
): void {
  getHarness(harness)?.keepQuestionOpen?.(sessionId, requestId);
}

export async function stopHarnessSession(
  harness: HarnessId,
  sessionId: string,
): Promise<void> {
  cancelIdlePark(sessionId);
  const adapter = getHarness(harness);
  if (!adapter?.live) return;
  if (activeTurnSessions.has(sessionId)) stoppedTurnSessions.add(sessionId);
  await adapter.stopSession(sessionId);
}

export async function forgetHarnessSession(
  harness: HarnessId,
  sessionId: string,
): Promise<void> {
  cancelIdlePark(sessionId);
  const adapter = getHarness(harness);
  if (!adapter) return;
  await adapter.forgetSession(sessionId);
}

export function bindHarnessSession(
  harness: HarnessId,
  threadId: string,
  providerSessionId: string,
  cwd: string,
  providerAccountId?: string,
  /** Restored transcript, so the adapter can reseed its task state. */
  blocks?: Block[],
): void {
  const adapter = getHarness(harness);
  adapter?.bindSession(threadId, providerSessionId, cwd, providerAccountId);
  if (!blocks || !adapter?.restoreTaskLists) return;
  const lists = blocks.flatMap((block) =>
    block.role === "tasks" && block.taskList ? [block.taskList] : [],
  );
  if (lists.length > 0) adapter.restoreTaskLists(threadId, lists);
}

/**
 * Probe model lists only for the harnesses the caller actually needs.
 * Boot used to refresh every adapter; that spawned unused CLIs (Pi with
 * extensions can sit at ~1GB) even when the workspace never touched them.
 */
/** `force` re-reads a catalog that already loaded, e.g. after a CLI update. */
export async function refreshHarnessCatalogs(
  ids: Iterable<HarnessId>,
  options?: { force?: boolean },
): Promise<void> {
  const wanted = new Set(ids);
  if (wanted.size === 0) return;
  await Promise.all(
    [...adapters.values()]
      .filter((adapter) => wanted.has(adapter.id))
      .map(async (adapter) => {
        if (!adapter.refreshCatalog) return;
        // `force` marks an explicit user action (opening the model dropdown);
        // routine refreshes keep skipping adapters with a live catalog.
        if (!options?.force && hasLiveCatalog(adapter.id)) return;
        await adapter.refreshCatalog().catch((error: unknown) => {
          console.debug(`[monocode] ${adapter.id} catalog`, error);
        });
      }),
  );
}

export async function generateHarnessTitle(
  harness: HarnessId,
  input: TitleInput,
): Promise<GeneratedSessionTitle | null> {
  const adapter = getHarness(harness);
  if (!adapter?.generateTitle) return null;
  return adapter.generateTitle(input);
}

export async function generateHarnessCommitMessage(
  harness: HarnessId,
  cwd: string,
  signal?: AbortSignal,
  paths?: readonly string[],
): Promise<string> {
  const adapter = requireHarness(harness);
  if (!adapter.generateCommitMessage) {
    throw new Error(`${harness} does not support commit message generation`);
  }
  signal?.throwIfAborted();
  return paths === undefined
    ? adapter.generateCommitMessage(cwd, signal)
    : adapter.generateCommitMessage(cwd, signal, paths);
}

export async function generateHarnessPrContent(
  harness: HarnessId,
  cwd: string,
): Promise<(PrContent & { base: string; head: string }) | null> {
  const adapter = getHarness(harness);
  if (!adapter?.generatePrContent) return null;
  return adapter.generatePrContent(cwd);
}

export async function generateHarnessBranchName(
  harness: HarnessId,
  cwd: string,
  message: string,
): Promise<string | null> {
  const adapter = getHarness(harness);
  if (!adapter?.generateBranchName) return null;
  return adapter.generateBranchName(cwd, message);
}

/** True when the harness itself can say which MCP servers a session has. */
export function canListHarnessMcpServers(harness: HarnessId): boolean {
  return getHarness(harness)?.listMcpServers != null;
}

export async function listHarnessMcpServers(
  harness: HarnessId,
  input: ListMcpServersInput,
): Promise<HarnessMcpServer[]> {
  const adapter = requireHarness(harness);
  if (!adapter.listMcpServers) {
    throw new Error(`${harness} does not report its MCP servers`);
  }
  return adapter.listMcpServers(input);
}

export async function warmupHarnessText(
  harness: HarnessId,
  cwd: string,
): Promise<void> {
  await getHarness(harness)?.warmupText?.(cwd);
}

export function canRunHarnessTextPrompt(harness: HarnessId): boolean {
  const adapter = getHarness(harness);
  return adapter?.live === true && adapter.runTextPrompt != null;
}

function stopTextPrompt(adapter: HarnessAdapter): Promise<void> {
  return adapter.stopTextPrompt
    ? adapter.stopTextPrompt().catch(() => undefined)
    : Promise.resolve();
}

const activeTextPromptOwners = new Map<HarnessAdapter, Set<symbol>>();

function beginTextPrompt(adapter: HarnessAdapter): symbol {
  const owner = Symbol("text-prompt");
  const owners = activeTextPromptOwners.get(adapter) ?? new Set<symbol>();
  owners.add(owner);
  activeTextPromptOwners.set(adapter, owners);
  return owner;
}

function finishTextPrompt(
  adapter: HarnessAdapter,
  owner: symbol,
  stopIfLast: boolean,
): void {
  const owners = activeTextPromptOwners.get(adapter);
  if (!owners?.delete(owner)) return;
  if (owners.size > 0) return;
  activeTextPromptOwners.delete(adapter);
  if (stopIfLast) void stopTextPrompt(adapter);
}

function cancelledTextPrompt(): Error {
  return new Error("By-the-way request cancelled");
}

export async function runHarnessTextPrompt(
  input: TextPromptInput & { harness: HarnessId },
): Promise<string> {
  const adapter = requireHarness(input.harness);
  if (!adapter.live) {
    throw new Error(`${input.harness} is not connected yet`);
  }
  if (!adapter.runTextPrompt) {
    throw new Error(`${input.harness} does not support isolated text prompts`);
  }

  const signal = input.signal;
  if (signal?.aborted) {
    throw cancelledTextPrompt();
  }

  const owner = beginTextPrompt(adapter);
  let run: Promise<string>;
  try {
    run = adapter.runTextPrompt(input);
  } catch (error) {
    finishTextPrompt(adapter, owner, false);
    throw error;
  }
  if (!signal) {
    try {
      return await run;
    } finally {
      finishTextPrompt(adapter, owner, false);
    }
  }

  let abortHandler: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    abortHandler = () => {
      finishTextPrompt(adapter, owner, false);
      reject(cancelledTextPrompt());
    };
    signal.addEventListener("abort", abortHandler, { once: true });
    if (signal.aborted) abortHandler();
  });
  try {
    return await Promise.race([run, abortPromise]);
  } finally {
    if (abortHandler) signal.removeEventListener("abort", abortHandler);
    finishTextPrompt(adapter, owner, false);
  }
}

export async function stopHarnessTextPrompts(): Promise<void> {
  await Promise.all([...adapters.values()].map(stopTextPrompt));
}
/**
 * Stops one background item. Not queued behind the turn: the turn is what
 * keeps running while the item does.
 */
export async function stopHarnessBackgroundTask(
  harness: HarnessId,
  sessionId: string,
  itemId: string,
): Promise<boolean> {
  const adapter = adapters.get(harness);
  if (!adapter?.stopBackgroundTask) return false;
  return adapter.stopBackgroundTask(sessionId, itemId);
}

/** Forks a chat natively. Throws when the harness has no native fork. */
export function forkHarnessSession(
  harness: HarnessId,
  input: {
    source: HarnessSessionInput;
    providerSessionId: string;
    newSessionId: string;
    boundary?: string;
  },
): Promise<{ providerSessionId?: string }> {
  const adapter = adapters.get(harness);
  if (!adapter?.forkSession) {
    return Promise.reject(new Error(`${harness} cannot fork a chat natively`));
  }
  // Behind any operation on the source, so a fork never races its last turn.
  return queueSessionOperation(input.source.sessionId, () =>
    adapter.forkSession!(input),
  );
}

/** The harness's own list, or null when it has none to ask. */
export async function listHarnessBackgroundTasks(
  harness: HarnessId,
  sessionId: string,
): Promise<BackgroundItem[] | null> {
  const adapter = adapters.get(harness);
  if (!adapter?.listBackgroundTasks) return null;
  try {
    return await adapter.listBackgroundTasks(sessionId);
  } catch {
    // Experimental methods may be missing on an older or local harness.
    return null;
  }
}

/** #45: whether the harness can list the sessions it keeps for a folder. */
export function harnessListsSessions(harness: HarnessId): boolean {
  return typeof adapters.get(harness)?.listSessions === "function";
}

/** #45: the harness's own sessions for the folder. Throws on failure. */
export async function listHarnessSessions(
  harness: HarnessId,
  input: ListSessionsInput,
): Promise<HarnessSessionRow[]> {
  const adapter = adapters.get(harness);
  if (!adapter?.listSessions) {
    throw new Error(`${harness} cannot list its sessions`);
  }
  return adapter.listSessions(input);
}

/**
 * #45: a listed session's earlier turns, or null where the harness cannot
 * replay them. Throws when it can and the call failed.
 */
export async function readHarnessSessionTurns(
  harness: HarnessId,
  input: ReadSessionInput,
): Promise<ImportedHistory | null> {
  const adapter = adapters.get(harness);
  if (!adapter?.readSessionTurns) return null;
  return adapter.readSessionTurns(input);
}
