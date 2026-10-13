import { TurnNotReadyError } from "../../core/types";
import { nativeModelId } from "../../../../features/sessions/model/models";
import { sameProviderAccountId } from "../../../../features/providers/model/providerAccounts";
import {
  exhaustedWindowResetAt,
  parseCodexRateLimits,
} from "../../../../features/providers/model/rateLimits";
import type { RuntimeMode } from "../../../../features/sessions/model/session";
import {
  questionPromptTitle,
  type UserQuestionReply,
} from "../../../../features/sessions/model/userQuestion";
import {
  killChild,
  resolveCodexBinary,
  restoreMonoCodexAgentState,
  spawnChild,
  unwatchChild,
  watchChild,
} from "../../core/child";
import {
  asRecord,
  buildThreadStartParams,
  buildTurnStartParams,
  buildTurnSteerParams,
  codexConfiguredMcpServers,
  codexMcpSwitches,
  codexMissingMcpNotice,
  codexGatewayConfigArgs,
  codexThreadConfig,
  isCodexMcpConfigError,
  isRecoverableThreadResumeError,
  isPlainCodexApproval,
  mapApprovalRequest,
  codexSubagentStates,
  codexSubagentThreadIds,
  mapCodexNotification,
  mapCodexSubagentSteps,
  stringField,
  toCodexApprovalDecision,
  type CodexApprovalKind,
} from "./codexProtocol";
import { JsonRpcClient, type JsonRpcId } from "../../core/jsonRpc";
import {
  deleteGeneratedImages,
  saveGeneratedImage,
} from "../../../../platform/tauri/fs";
import {
  codexAsyncQuestions,
  codexAsyncQuestionResponse,
  codexQuestions,
  codexQuestionResponse,
} from "./codexQuestions";
import { codexMcpConfirmation } from "./codexElicitation";
import { snapshotRemainder } from "../../core/streamText";
import { ruleDecision, toolRules, type ToolRules } from "../../core/toolRules";
import { CODEX_COMMAND_TOOL } from "../../../../features/tool-access/model/toolAccess";
import { prepareCodexMonoContext } from "./codexStore";
import type {
  ApprovalDecision,
  CompactContextInput,
  HarnessEvent,
  HarnessSessionInput,
  HarnessToolAccess,
  RewindLastTurnInput,
  RewindLastTurnResult,
  SendTurnInput,
  SteerTurnInput,
} from "../../core/types";
// [lane-1] imports
// [lane-2] imports
// [lane-3] imports
// [lane-4] imports
// [lane-5] imports
import { codexMcpResultImages as codexMcpResultImages_l5 } from "../../../../features/browser-tools/model/codexMcpImages";
import { keepToolResultImages as keepToolResultImages_l5 } from "../../../../features/tool-images/data/toolImageStore";
import {
  codexElicitationContent as codexElicitationContent_l5,
  codexElicitationForm as codexElicitationForm_l5,
  codexElicitationSignIn as codexElicitationSignIn_l5,
} from "./codexElicitation";
import {
  chatFolders as chatFolders_l5,
  codexRequestInsideChatFolders as codexRequestInsideChatFolders_l5,
  recordCodexFileChange as recordCodexFileChange_l5,
  type CodexFileChangeLog as CodexFileChangeLog_l5,
} from "../../../../features/tool-access/model/chatFolders";
import {
  codexThreadIdentity as codexThreadIdentity_l5,
  codexThreadIdentityKey as codexThreadIdentityKey_l5,
  pickCodexNetworkAmendment as pickCodexNetworkAmendment_l5,
  codexNetworkAmendmentDecision as codexNetworkAmendmentDecision_l5,
  type CodexNetworkAmendment as CodexNetworkAmendment_l5,
} from "./codexProviders";
import {
  codexEditAdapter as codexEditAdapter_l5,
  editAdapterConfig as editAdapterConfig_l5,
} from "../../../../features/model-setup/model/editAdapter";

type ApprovalOutcome = ApprovalDecision | "cancelled";

type PendingApproval = {
  rpcId: JsonRpcId;
  threadId: string;
  kind: CodexApprovalKind;
  /** The per-chat rule key of the request, where it has one. */
  toolKey?: string;
  /** Host rules Codex proposed with a network request; see `respondCodexApproval`. */
  networkAmendments?: CodexNetworkAmendment_l5[];
  /** The proposed `allow` the user picked with "Always allow <host>". */
  chosenAmendment?: { host: string; action: "allow" };
  /**
   * The request is plain, so Codex may keep its grant for the session if
   * its files are inside the chat's folders (checked when answered).
   */
  sessionGrantOk?: boolean;
  /** The user picked "Allow for this chat". */
  forChat?: boolean;
  resolve: (decision: ApprovalOutcome) => void;
};

type PendingQuestion = {
  /** Async agentMessage questions have no pending server request. */
  rpcId: JsonRpcId | null;
  threadId: string;
  turnId?: string;
  sending?: boolean;
  event: Extract<HarnessEvent, { type: "question.asked" }>;
  isBlocking: boolean;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (reply: UserQuestionReply | "cancelled") => void;
};

// Reading the configuration only narrows which MCP switches are sent, so a
// slow answer must not hold up opening the thread.
const CONFIG_READ_TIMEOUT_MS = 10_000;

// Match Codex's non-blocking question policy: a minute of grace, then a
// minute of countdown. Interaction keeps the question open for the user.
const QUESTION_AUTO_RESOLVE_MS = 120_000;

type Live = {
  rpc: JsonRpcClient;
  threadId: string;
  /** MonoCode's chat id; names the images this chat saves. */
  sessionId?: string;
  cwd: string;
  providerAccountId?: string;
  /** Thread-level network policy used when this app-server opened the thread. */
  controlsAgents: boolean;
  ephemeral: boolean;
  codexStore?: "mono";
  /** MCP servers this thread was opened without; a change reopens it. */
  mcpKey: string;
  /** The switches last asked for; the same ones need no second look. */
  mcpRequested: string;
  /**
   * The `-c` flags that added Docker gateway connectors to this app-server.
   * They are process flags, so a different set starts a new app-server.
   */
  gatewayKey: string;
  runtimeMode: RuntimeMode;
  planning: boolean;
  /**
   * The chat's per-tool rules. Set from each turn's input, and replaced in
   * between by `setCodexToolAccess` when the user changes a rule.
   */
  toolRules: ToolRules;
  onEvent: (event: HarnessEvent) => void;
  approvals: Map<number, PendingApproval>;
  questions: Map<number, PendingQuestion>;
  visibleQuestionId: number | null;
  nextApprovalUiId: number;
  cancelled: boolean;
  muteUpdates: boolean;
  activeTurnId: string | null;
  turns: Promise<void>;
  /** Resolves when the current turn completes (or is cancelled). */
  turnDone: (() => void) | null;
  turnFailed: ((error: Error) => void) | null;
  /** turn/completed arrived before runTurn registered turnDone. */
  turnEndPending: boolean;
  /** Completed snapshots describe one item, not all text in the turn. */
  emittedAssistantByItem: Map<string, string>;
  emittedReasoningByItem: Map<string, string>;
  emittedGeneratedImages: Set<string>;
  emittedAsyncQuestions: Set<string>;
  turnGeneration: number;
  notificationQueue: Promise<void> | null;
  /** Child thread id -> the agent tool row that spawned it. */
  subagentThreads: Map<string, string>;
  /** Child notifications that arrived before their row was known. */
  pendingSubagent: Map<string, Array<{ method: string; params: unknown }>>;
  /** Agent rows still running, by call id, with the name to settle them under. */
  openAgentRows: Map<string, string>;
  /** Latest rate-limit windows by limit id, merged from sparse updates. */
  rateLimits: Map<string, Record<string, unknown>>;
  /** The active turn failed on a spent usage limit. */
  usageLimited: boolean;
  // [lane-1] live
  // [lane-2] live
  // [lane-3] live
  // [lane-4] live
  // [lane-5] live
  /** Paths of recent file change items, by item id. */
  fileChanges_l5: CodexFileChangeLog_l5;
  /** The chat's working folder and added folders, for automatic yeses. */
  chatFolders_l5: string[];
  /** Model provider and permissions profile the thread was opened with. */
  identityKey_l5: string;
  /** Session 10: the edit adapter route the thread was opened with, or "". */
  editAdapterKey_l5: string;
};

function trackNotificationQueue(live: Live, queued: Promise<void>): void {
  live.notificationQueue = queued;
  void queued.then(() => {
    if (live.notificationQueue === queued) live.notificationQueue = null;
  });
}

type Resume = {
  threadId: string;
  cwd: string;
  providerAccountId?: string;
  ephemeral?: boolean;
  codexStore?: "mono";
};

const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, Resume>();
const cancelledThreads = new Set<string>();
/** Switches each session was already told its Codex cannot act on. */
const missingMcpNoted = new Map<string, string>();

let resolveCodexBinaryImpl: () => Promise<{ path: string }> =
  resolveCodexBinary;

/** Test seam. */
export function setCodexBinaryResolver(
  fn: () => Promise<{ path: string }>,
): void {
  resolveCodexBinaryImpl = fn;
}

export async function sendCodexTurn(input: SendTurnInput): Promise<void> {
  let live: Live;
  try {
    live = await ensureLive(input);
  } catch (error) {
    cancelledThreads.delete(input.sessionId);
    throw error;
  }
  if (cancelledThreads.delete(input.sessionId)) return;

  live.onEvent = input.onEvent;
  live.toolRules = toolRules(input.toolAccess);
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
      live.runtimeMode = input.runtimeMode;
      live.planning = input.intent === "plan";
      live.cancelled = false;
      live.muteUpdates = false;
      try {
        await runTurn(live, input);
      } catch (error) {
        if (live.cancelled) return;
        throw error;
      }
    });
  await live.turns;
}

export async function compactCodexContext(
  input: CompactContextInput,
): Promise<void> {
  if (input.ephemeral && !hasLiveCodexSession(input.sessionId, true)) {
    throw new Error("Send a message before compacting this chat");
  }
  let live: Live;
  try {
    live = await ensureLive(input);
  } catch (error) {
    cancelledThreads.delete(input.sessionId);
    throw error;
  }
  if (cancelledThreads.delete(input.sessionId)) return;

  live.onEvent = input.onEvent;
  live.toolRules = toolRules(input.toolAccess);
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
      live.cancelled = false;
      live.muteUpdates = false;
      try {
        await runCompaction(live);
      } catch (error) {
        if (live.cancelled) return;
        throw error;
      }
    });
  await live.turns;
}

export async function rewindCodexLastTurn(
  input: RewindLastTurnInput,
): Promise<RewindLastTurnResult> {
  // An ephemeral helper has no native turn to revert after its process exits.
  if (input.ephemeral && !hasLiveCodexSession(input.sessionId, true)) {
    return { submitted: false };
  }
  let live: Live;
  try {
    live = await ensureLive(input);
  } catch (error) {
    cancelledThreads.delete(input.sessionId);
    throw error;
  }
  if (cancelledThreads.delete(input.sessionId)) return { submitted: false };

  live.onEvent = input.onEvent;
  await live.turns;
  if (live.activeTurnId) {
    throw new Error("Stop the current turn before editing the last message");
  }

  const beforeTurnId = await lastUserTurnId(live, input.providerTurnId);
  await live.rpc.request("thread/revert", {
    threadId: live.threadId,
    beforeTurnId,
  });
  return { submitted: false };
}

async function lastUserTurnId(
  live: Live,
  providerTurnId?: string,
): Promise<string> {
  const exact = providerTurnId?.trim();
  if (exact) return exact;

  const page = await live.rpc.request<{ data?: unknown[] }>(
    "thread/turns/list",
    {
      threadId: live.threadId,
      limit: 100,
      sortDirection: "desc",
      itemsView: "summary",
    },
  );
  const turns = Array.isArray(page.data) ? page.data : [];
  const userTurn = turns.find((candidate) => {
    const turn = asRecord(candidate);
    return (
      Array.isArray(turn?.items) &&
      turn.items.some(
        (item) => stringField(asRecord(item), "type") === "userMessage",
      )
    );
  });
  const latest = asRecord(userTurn);
  const turnId = stringField(latest, "id");
  if (!turnId) throw new Error("Codex did not expose a user turn id to edit");
  return turnId;
}

export async function steerCodexTurn(input: SteerTurnInput): Promise<void> {
  const live = liveByThread.get(input.sessionId);
  if (!live) throw new TurnNotReadyError("No active Codex session");
  const turnId = live.activeTurnId;
  if (!turnId) throw new TurnNotReadyError("No active turn to steer");

  const params = buildTurnSteerParams({
    threadId: live.threadId,
    expectedTurnId: turnId,
    prompt: input.text.trim() || undefined,
    attachments: input.attachments,
  });
  if (
    !params.input ||
    (Array.isArray(params.input) && params.input.length === 0)
  ) {
    return;
  }

  try {
    await live.rpc.request("turn/steer", params);
  } catch (error) {
    if (live.activeTurnId !== turnId)
      throw new TurnNotReadyError(
        "The Codex turn ended before the follow-up arrived",
      );
    throw error;
  }
  live.onEvent({ type: "turn.started", providerTurnId: turnId });
}

export function respondCodexApproval(
  sessionId: string,
  requestId: number,
  decision: ApprovalDecision,
  options?: {
    networkAmendment?: { host: string; action: "allow" };
    forChat?: boolean;
  },
): void {
  const live = liveByThread.get(sessionId);
  const pending = live?.approvals.get(requestId);
  if (!pending) return;
  // Only an allow Codex proposed for this request is ever sent back; any
  // other host falls back to a plain accept.
  if (decision === "allow") {
    const chosen = pickCodexNetworkAmendment_l5(
      pending.networkAmendments,
      options?.networkAmendment,
    );
    if (chosen) pending.chosenAmendment = chosen;
    if (options?.forChat) pending.forChat = true;
  }
  pending.resolve(decision);
}

/**
 * Replace a live session's per-tool rules, so a rule the user sets while a
 * turn runs answers the next request. A card already on screen for a tool
 * that is now blocked is declined; one for a tool that is now always allowed
 * stays for the user to answer.
 *
 * Rules only answer requests Codex sends. It does not ask in every mode, and
 * it runs commands it considers safe without asking, so "never" declines
 * whenever Codex asks. It does not stop Codex from running commands.
 */
export function setCodexToolAccess(
  sessionId: string,
  access?: HarnessToolAccess,
): void {
  const live = liveByThread.get(sessionId);
  if (!live) return;
  live.toolRules = toolRules(access);
  for (const pending of [...live.approvals.values()]) {
    if (ruleDecision(live.toolRules, pending.toolKey) === "deny") {
      pending.resolve("deny");
    }
  }
}

export function respondCodexQuestion(
  sessionId: string,
  requestId: number,
  reply: UserQuestionReply,
): void {
  const live = liveByThread.get(sessionId);
  const pending = live?.questions.get(requestId);
  if (!live || !pending || pending.sending) return;
  if (pending.rpcId !== null || reply.kind === "skipped") {
    pending.resolve(reply);
    return;
  }
  const text = codexAsyncQuestionResponse(pending.event.questions, reply);
  if (!text) {
    pending.resolve({ kind: "skipped" });
    return;
  }
  const turnId = pending.turnId;
  if (!turnId || live.activeTurnId !== turnId) {
    pending.resolve("cancelled");
    return;
  }
  pending.sending = true;
  keepCodexQuestionOpen(sessionId, requestId);
  void live.rpc
    .request(
      "turn/steer",
      buildTurnSteerParams({
        threadId: pending.threadId,
        expectedTurnId: turnId,
        prompt: text,
      }),
    )
    .then(() => {
      if (live.questions.get(requestId) === pending) pending.resolve(reply);
    })
    .catch((error: unknown) => {
      pending.sending = false;
      if (live.questions.get(requestId) !== pending) return;
      live.onEvent({
        type: "status",
        text: `Could not send your answer to Codex: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
}

export function keepCodexQuestionOpen(
  sessionId: string,
  requestId: number,
): void {
  const live = liveByThread.get(sessionId);
  const pending = live?.questions.get(requestId);
  if (!live || !pending || pending.timer === undefined) return;
  clearTimeout(pending.timer);
  pending.timer = undefined;
  live.onEvent({ type: "question.updated", requestId });
}

function clearServerRequests(live: Live): void {
  for (const pending of live.approvals.values()) pending.resolve("cancelled");
  for (const pending of live.questions.values()) {
    clearTimeout(pending.timer);
    pending.resolve("cancelled");
  }
  live.approvals.clear();
  live.questions.clear();
  live.visibleQuestionId = null;
}

function showNextQuestion(live: Live): void {
  if (
    live.visibleQuestionId !== null &&
    live.questions.has(live.visibleQuestionId)
  )
    return;
  const next = live.questions.entries().next().value;
  live.visibleQuestionId = next?.[0] ?? null;
  if (next) {
    const pending = next[1];
    if (!pending.isBlocking) {
      pending.event.autoResolveAt = Date.now() + QUESTION_AUTO_RESOLVE_MS;
      pending.timer = setTimeout(
        () => pending.resolve({ kind: "skipped" }),
        QUESTION_AUTO_RESOLVE_MS,
      );
    }
    live.onEvent(pending.event);
  }
}

export async function cancelCodexTurn(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  if (!live) {
    cancelledThreads.add(sessionId);
    return;
  }
  live.cancelled = true;
  live.muteUpdates = true;
  clearServerRequests(live);
  const turnId = live.activeTurnId;
  if (turnId) {
    await live.rpc
      .request("turn/interrupt", {
        threadId: live.threadId,
        turnId,
      })
      .catch(() => undefined);
  }
  finishActiveTurn(live, [
    { type: "message.completed" },
    { type: "reasoning.completed" },
  ]);
}

export async function stopCodexSession(sessionId: string): Promise<void> {
  cancelledThreads.delete(sessionId);
  const live = liveByThread.get(sessionId);
  liveByThread.delete(sessionId);
  if (live) {
    live.muteUpdates = true;
    live.turnGeneration += 1;
    clearServerRequests(live);
    live.turnDone?.();
    live.turnDone = null;
    live.turnFailed = null;
    live.rpc.close();
  }
  unwatchChild(sessionId);
  await killChild(sessionId).catch(() => undefined);
}

export async function forgetCodexSession(sessionId: string): Promise<void> {
  resumeByThread.delete(sessionId);
  missingMcpNoted.delete(sessionId);
  await stopCodexSession(sessionId);
}

export function bindCodexSession(
  threadId: string,
  providerSessionId: string,
  cwd: string,
  providerAccountId?: string,
): void {
  const providerThreadId = providerSessionId.trim();
  if (!threadId || !providerThreadId || !cwd.trim()) return;
  resumeByThread.set(threadId, {
    threadId: providerThreadId,
    cwd,
    providerAccountId,
  });
}

export async function migrateMonoCodexSession(input: {
  sessionId: string;
  threadId: string;
  cwd: string;
  providerAccountId?: string;
}): Promise<void> {
  const { path } = await resolveCodexBinaryImpl();
  await prepareCodexMonoContext({ ...input, path, migrationOnly: true });
}

/** Ephemeral context exists only while its app-server is alive. */
export function hasLiveCodexSession(
  sessionId: string,
  ephemeral?: boolean,
): boolean {
  const live = liveByThread.get(sessionId);
  return (
    !!live &&
    !live.rpc.isClosed &&
    (ephemeral === undefined || live.ephemeral === ephemeral)
  );
}

async function ensureLive(input: HarnessSessionInput): Promise<Live> {
  const existing = liveByThread.get(input.sessionId);
  const controlsAgents = input.controlsAgents === true;
  const ephemeral =
    input.ephemeral ??
    existing?.ephemeral ??
    resumeByThread.get(input.sessionId)?.ephemeral ??
    false;
  const codexStore =
    input.codexStore ??
    existing?.codexStore ??
    resumeByThread.get(input.sessionId)?.codexStore;
  const disabledMcp = [...new Set(input.disabledMcpServers ?? [])].sort();
  const mcpRequested = disabledMcp.join("\n");
  const gatewayArgs = codexGatewayConfigArgs(
    [...(input.gatewayConnectors ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  );
  const gatewayKey = gatewayArgs.join("\n");
  // [lane-1] reuse-key
  // [lane-2] reuse-key
  // [lane-3] reuse-key
  // [lane-4] reuse-key
  // [lane-5] reuse-key
  const identity_l5 = codexThreadIdentity_l5(input);
  const identityKey_l5 = codexThreadIdentityKey_l5(identity_l5);
  // Session 10: the edit adapter, when it is on for this chat's provider.
  // A failure to open it leaves Codex talking to the model server directly.
  const editAdapter_l5 = await codexEditAdapter_l5(input);
  if (editAdapter_l5.error)
    console.warn("Edit adapter not used:", editAdapter_l5.error);
  // The servers this session's Codex has an entry for, once it was asked;
  // null when it could not say.
  let mcpConfigured: Set<string> | null | undefined;
  if (
    existing &&
    existing.cwd === input.cwd &&
    sameProviderAccountId(
      existing.providerAccountId,
      input.providerAccountId,
    ) &&
    existing.controlsAgents === controlsAgents &&
    existing.ephemeral === ephemeral &&
    existing.codexStore === codexStore &&
    existing.gatewayKey === gatewayKey &&
    // [lane-1] reuse
    // [lane-2] reuse
    // [lane-3] reuse
    // [lane-4] reuse
    // [lane-5] reuse
    existing.identityKey_l5 === identityKey_l5 &&
    existing.editAdapterKey_l5 === editAdapter_l5.key
  ) {
    if (existing.mcpRequested === mcpRequested) {
      existing.onEvent = input.onEvent;
      return existing;
    }
    // The switches changed. Only those for servers this Codex has are ever
    // applied, so a switch for any other name leaves the thread as it is.
    if (disabledMcp.length > 0) {
      mcpConfigured = await readConfiguredMcpServers(
        existing.rpc,
        existing.cwd,
      );
    }
    const switches = codexMcpSwitches(disabledMcp, mcpConfigured ?? null);
    if (
      switches.key === existing.mcpKey &&
      liveByThread.get(input.sessionId) === existing &&
      !existing.rpc.isClosed
    ) {
      existing.mcpRequested = mcpRequested;
      existing.onEvent = input.onEvent;
      noteMissingMcpServers(input.sessionId, switches.dropped, input.onEvent);
      return existing;
    }
  }
  if (existing) {
    // Codex may retain the thread's sandbox network policy across turns.
    // Switch it when this session gains /operator access or loses agent
    // control, so its local CLI socket matches the current policy.
    // MCP servers are part of the configuration a thread is opened with, so
    // switching one of this Codex's servers reopens the thread the same way.
    if (
      existing.cwd !== input.cwd ||
      !sameProviderAccountId(
        existing.providerAccountId,
        input.providerAccountId,
      )
    ) {
      resumeByThread.delete(input.sessionId);
    }
    await stopCodexSession(input.sessionId);
  }

  const resume = resumeByThread.get(input.sessionId);
  const canResume =
    !ephemeral &&
    resume != null &&
    resume.cwd === input.cwd &&
    sameProviderAccountId(resume.providerAccountId, input.providerAccountId);
  if (
    resume &&
    (resume.cwd !== input.cwd ||
      !sameProviderAccountId(resume.providerAccountId, input.providerAccountId))
  ) {
    resumeByThread.delete(input.sessionId);
  }

  const { path } = await resolveCodexBinaryImpl();
  const store =
    codexStore === "mono"
      ? await prepareCodexMonoContext({
          sessionId: input.sessionId,
          path,
          cwd: input.cwd,
          providerAccountId: input.providerAccountId,
          threadId: canResume ? resume?.threadId : undefined,
        })
      : undefined;
  const storeConfig = store?.config;
  const liveRef: { current: Live | null } = { current: null };

  const rpc = new JsonRpcClient(
    input.sessionId,
    {
      onNotification: (method, params) => {
        const live = liveRef.current;
        if (live)
          noteCodexNotification_l5(live, input.sessionId, method, params);
        if (!live || live.muteUpdates) return;
        if (live.notificationQueue) {
          const turnGeneration = live.turnGeneration;
          const queued = live.notificationQueue
            .catch(() => undefined)
            .then(() => {
              if (
                live.muteUpdates ||
                live.cancelled ||
                turnGeneration !== live.turnGeneration
              ) {
                return;
              }
              return handleNotification(live, method, params);
            });
          trackNotificationQueue(
            live,
            queued.catch(() => undefined),
          );
          return;
        }
        const result = handleNotification(live, method, params);
        if (!result) return;
        trackNotificationQueue(
          live,
          result.catch(() => undefined),
        );
      },
      onRequest: (id, method, params) => {
        const live = liveRef.current;
        const turn = live?.turnDone;
        // The external clock can be requested before thread/start or resume
        // returns, so it must not depend on the live session being bound.
        const response =
          method === "currentTime/read"
            ? rpc.respond(id, { currentTimeAt: Math.floor(Date.now() / 1000) })
            : live
              ? handleServerRequest(live, id, method, params)
              : undefined;
        void response?.catch((error: unknown) => {
          if (live?.muteUpdates || (live && live.turnDone !== turn)) return;
          const failure =
            error instanceof Error ? error : new Error(String(error));
          if (live?.turnFailed) {
            live.turnFailed(failure);
          } else {
            (live?.onEvent ?? input.onEvent)({
              type: "session.error",
              message: failure.message,
            });
          }
        });
      },
    },
    { includeJsonrpc: false, label: "codex" },
  );

  watchChild(
    input.sessionId,
    (line) => rpc.pushLine(line),
    (code) => {
      rpc.close(new Error("Codex app-server exited"));
      liveByThread.delete(input.sessionId);
      const live = liveRef.current;
      if (!live?.muteUpdates) {
        (live?.onEvent ?? input.onEvent)({ type: "session.ended", code });
      }
      live?.turnFailed?.(new Error("Codex app-server exited"));
      if (live) {
        clearServerRequests(live);
        live.turnDone = null;
        live.turnFailed = null;
      }
    },
  );

  await spawnChild(
    input.sessionId,
    path,
    ["app-server", ...gatewayArgs],
    input.cwd,
    {
      provider: "codex",
      id: input.providerAccountId ?? "default",
    },
    "codex",
    codexStore,
  );

  try {
    await rpc.request("initialize", {
      clientInfo: {
        name: "monocode",
        title: "MonoCode",
        version: "0.1.0",
      },
      capabilities: {
        // Required by collaborationMode (including Plan); currentTime/read is
        // handled above even while the thread is starting or resuming.
        experimentalApi: true,
      },
    });
    await rpc.notify("initialized", undefined);
    if (store?.hasThread && canResume && resume) {
      await restoreMonoCodexAgentState(
        input.providerAccountId,
        resume.threadId,
      );
    }

    const model = nativeModelId(input.model);
    const serviceTier = input.modelSettings?.serviceTier;
    const effort = input.modelSettings?.reasoningEffort;

    let threadId: string | undefined;
    let didResume = false;

    // An override for a server Codex has no entry for fails the whole
    // configuration load, so only switch off servers this Codex knows. The
    // app-server this one replaces ran the same Codex and was asked a moment
    // ago; its answer still holds.
    if (disabledMcp.length > 0 && !mcpConfigured) {
      mcpConfigured = await readConfiguredMcpServers(rpc, input.cwd);
    }
    const mcpSwitches = codexMcpSwitches(disabledMcp, mcpConfigured ?? null);
    let mcpOff = mcpSwitches.applied;
    let mcpRejected = false;
    const openThread = async (
      method: "thread/start" | "thread/resume",
      params: Record<string, unknown>,
    ) => {
      const request = (off: string[]) => {
        const config = codexThreadConfig(
          storeConfig
            ? {
                ...storeConfig,
                ...(params.config as Record<string, unknown> | undefined),
              }
            : (params.config as Record<string, unknown> | undefined),
          off,
        );
        return rpc.request<{ thread?: { id?: string } }>(method, {
          ...params,
          ...(config ? { config } : {}),
        });
      };
      try {
        return await request(mcpOff);
      } catch (error) {
        if (mcpOff.length === 0 || !isCodexMcpConfigError(error)) throw error;
        // Codex could not load one of the switched-off entries. A chat that
        // opens with every server on beats one that cannot open at all.
        mcpOff = [];
        mcpRejected = true;
        return request([]);
      }
    };

    if (canResume && resume) {
      try {
        const params = buildThreadStartParams({
          cwd: input.cwd,
          runtimeMode: input.runtimeMode,
          controlsAgents: input.controlsAgents,
          model,
          serviceTier,
          extraDirs: input.extraDirs,
          // [lane-1] thread-resume-call
          // [lane-2] thread-resume-call
          // [lane-3] thread-resume-call
          // [lane-4] thread-resume-call
          // [lane-5] thread-resume-call
          ...identity_l5,
          providerConfig: editAdapterConfig_l5(editAdapter_l5),
        });
        const opened = await openThread("thread/resume", {
          threadId: resume.threadId,
          ...params,
        });
        threadId = opened.thread?.id ?? resume.threadId;
        didResume = true;
      } catch (error) {
        if (store?.hasThread)
          throw new Error(
            "The saved Mono Codex context could not be resumed. Retry to keep its saved context.",
          );
        if (!isRecoverableThreadResumeError(error)) throw error;
        threadId = undefined;
      }
    }

    if (!threadId) {
      const params = buildThreadStartParams({
        cwd: input.cwd,
        runtimeMode: input.runtimeMode,
        controlsAgents: input.controlsAgents,
        model,
        serviceTier,
        extraDirs: input.extraDirs,
        // [lane-1] thread-start-call
        // [lane-2] thread-start-call
        developerInstructions: input.developerInstructions,
        // [lane-3] thread-start-call
        // [lane-4] thread-start-call
        // [lane-5] thread-start-call
        ...identity_l5,
        providerConfig: editAdapterConfig_l5(editAdapter_l5),
      });
      const opened = await openThread("thread/start", {
        ...params,
        ...(ephemeral ? { ephemeral: true } : {}),
      });
      threadId = opened.thread?.id?.trim();
    }

    if (!threadId) throw new Error("Codex did not return a thread id");

    // Suppress unused warning for effort until first turn applies it.
    void effort;

    const live: Live = {
      rpc,
      threadId,
      cwd: input.cwd,
      providerAccountId: input.providerAccountId,
      sessionId: input.sessionId,
      controlsAgents,
      ephemeral,
      codexStore,
      mcpKey: mcpRejected ? "" : mcpSwitches.key,
      mcpRequested,
      gatewayKey,
      runtimeMode: input.runtimeMode,
      planning: input.intent === "plan",
      onEvent: input.onEvent,
      toolRules: toolRules(input.toolAccess),
      approvals: new Map(),
      questions: new Map(),
      visibleQuestionId: null,
      nextApprovalUiId: 1,
      cancelled: false,
      muteUpdates: didResume,
      activeTurnId: null,
      turns: Promise.resolve(),
      turnDone: null,
      turnFailed: null,
      turnEndPending: false,
      emittedAssistantByItem: new Map(),
      emittedReasoningByItem: new Map(),
      emittedGeneratedImages: new Set(),
      emittedAsyncQuestions: new Set(),
      turnGeneration: 0,
      notificationQueue: null,
      subagentThreads: new Map(),
      pendingSubagent: new Map(),
      openAgentRows: new Map(),
      rateLimits: new Map(),
      usageLimited: false,
      // [lane-1] live-init
      // [lane-2] live-init
      // [lane-3] live-init
      // [lane-4] live-init
      // [lane-5] live-init
      fileChanges_l5: new Map(),
      chatFolders_l5: chatFolders_l5(input.cwd, input.extraDirs),
      identityKey_l5,
      editAdapterKey_l5: editAdapter_l5.key,
    };
    liveRef.current = live;
    liveByThread.set(input.sessionId, live);
    resumeByThread.set(input.sessionId, {
      threadId,
      cwd: input.cwd,
      providerAccountId: input.providerAccountId,
      ephemeral,
      codexStore,
    });
    live.onEvent({
      type: "session.providerBound",
      providerSessionId: threadId,
    });
    live.onEvent({ type: "session.started" });
    if (mcpRejected) {
      live.onEvent({
        type: "status",
        text: "Codex could not apply this chat's connector switches, so all of its MCP servers are on.",
      });
    } else {
      noteMissingMcpServers(input.sessionId, mcpSwitches.dropped, live.onEvent);
    }
    return live;
  } catch (error) {
    rpc.close(error instanceof Error ? error : new Error(String(error)));
    await stopCodexSession(input.sessionId);
    throw error;
  }
}

/** Server names in this Codex's configuration, or null when it cannot say. */
function readConfiguredMcpServers(
  rpc: JsonRpcClient,
  cwd: string,
): Promise<Set<string> | null> {
  return rpc
    .request("config/read", { cwd }, CONFIG_READ_TIMEOUT_MS)
    .then(codexConfiguredMcpServers, () => null);
}

/**
 * Says once per change which switched-off names this session's Codex has no
 * server for. The switches stay saved with the chat, so without this the
 * composer would count a server as off that was never there to switch.
 */
function noteMissingMcpServers(
  sessionId: string,
  missing: string[],
  onEvent: (event: HarnessEvent) => void,
): void {
  const key = missing.join("\n");
  if ((missingMcpNoted.get(sessionId) ?? "") === key) return;
  if (!key) {
    missingMcpNoted.delete(sessionId);
    return;
  }
  missingMcpNoted.set(sessionId, key);
  onEvent({ type: "status", text: codexMissingMcpNotice(missing) });
}

async function runTurn(live: Live, input: SendTurnInput): Promise<void> {
  const model = nativeModelId(input.model);
  const effort = input.modelSettings?.reasoningEffort;
  const serviceTier = input.modelSettings?.serviceTier;

  const params = buildTurnStartParams({
    threadId: live.threadId,
    runtimeMode: input.runtimeMode,
    controlsAgents: input.controlsAgents,
    prompt: input.text.trim() || undefined,
    attachments: input.attachments,
    model,
    effort,
    serviceTier,
    intent: input.intent,
    extraDirs: input.extraDirs,
    // [lane-1] turn-start-call
    // [lane-2] turn-start-call
    // [lane-3] turn-start-call
    // [lane-4] turn-start-call
    // [lane-5] turn-start-call
    ...noteCodexChatFolders_l5(live, input.extraDirs),
    permissionsProfile: codexThreadIdentity_l5(input).permissionsProfile,
    autoReviewOff: codexThreadIdentity_l5(input).autoReviewOff,
    commandsAlways: ruleDecision(live.toolRules, CODEX_COMMAND_TOOL) === "allow",
  });

  if (Array.isArray(params.input) && params.input.length === 0) {
    return;
  }

  live.emittedAssistantByItem.clear();
  live.emittedReasoningByItem.clear();
  live.emittedGeneratedImages.clear();
  live.emittedAsyncQuestions.clear();
  live.turnGeneration += 1;

  const turnPromise = new Promise<void>((resolve, reject) => {
    live.turnDone = resolve;
    live.turnFailed = reject;
  });
  settlePendingTurn(live);

  try {
    const response = await live.rpc.request<{ turn?: { id?: string } }>(
      "turn/start",
      params,
    );
    input.onAccepted?.();
    const turnId = response.turn?.id ?? live.activeTurnId;
    // turn/completed can arrive before turn/start returns; don't resurrect a
    // finished turn's id after finishActiveTurn cleared activeTurnId.
    if (turnId && live.turnDone) {
      live.activeTurnId = live.activeTurnId ?? turnId;
      live.onEvent({ type: "turn.started", providerTurnId: turnId });
    }
    settlePendingTurn(live);
    await turnPromise;
  } catch (error) {
    if (live.cancelled) return;
    live.onEvent({
      type: "session.error",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    live.turnDone = null;
    live.turnFailed = null;
  }
}

async function runCompaction(live: Live): Promise<void> {
  live.emittedAssistantByItem.clear();
  live.emittedReasoningByItem.clear();
  live.emittedGeneratedImages.clear();
  const turnPromise = new Promise<void>((resolve, reject) => {
    live.turnDone = resolve;
    live.turnFailed = reject;
  });
  settlePendingTurn(live);

  try {
    await live.rpc.request("thread/compact/start", {
      threadId: live.threadId,
    });
    settlePendingTurn(live);
    await turnPromise;
  } finally {
    live.turnDone = null;
    live.turnFailed = null;
  }
}

function handleNotification(
  live: Live,
  method: string,
  params: unknown,
): void | Promise<void> {
  if (live.muteUpdates || live.cancelled) return;
  const rec = asRecord(params);
  if (method === "serverRequest/resolved") {
    for (const pending of live.approvals.values()) {
      if (
        pending.rpcId === rec?.requestId &&
        pending.threadId === rec?.threadId
      )
        pending.resolve("cancelled");
    }
    for (const pending of live.questions.values()) {
      if (
        pending.rpcId === rec?.requestId &&
        pending.threadId === rec?.threadId
      )
        pending.resolve("cancelled");
    }
    return;
  }
  // Child threads share this connection. Their lifecycle must not touch the
  // parent's turn or clear its approvals, but what they do is the inside of a
  // subagent — mirror it onto the row that spawned them.
  const threadId =
    stringField(rec, "threadId") ??
    (method === "thread/started"
      ? stringField(asRecord(rec?.thread), "id")
      : undefined);
  if (threadId && threadId !== live.threadId) {
    return handleSubagentNotification(live, threadId, method, params);
  }
  // A Codex turn is a sequence of items. Completing an agentMessage does not
  // mean the turn is over — more tools and messages can still arrive. Only
  // turn/completed (and turn/aborted) settle sendCodexTurn, which is what the
  // UI uses for busy / stop / "Working for".
  const mapped = mapCodexNotification(method, params);
  if (mapped.diagnostic) {
    console.debug(
      `[monocode] codex ${live.threadId} ${method}`,
      mapped.diagnostic,
    );
  }
  // Codex describes one spawned agent through more than one item type. The
  // first row to name a child thread owns it; a later item for the same thread
  // would otherwise stand up a second agent that never does anything.
  const duplicate = bindSubagentThreads(live, method, rec);
  const snapshot = method === "item/completed";
  const itemId = snapshot
    ? stringField(asRecord(rec?.item), "id")
    : stringField(rec, "itemId");
  let pending: Promise<void> | undefined;
  for (const event of mapped.events) {
    if (duplicate && duplicateAgentRow(event)) continue;
    if (event.type === "image.generated") {
      if (live.emittedGeneratedImages.has(event.itemId)) continue;
      live.emittedGeneratedImages.add(event.itemId);
      if ("data" in event) {
        const save = () => materializeGeneratedImage(live, event);
        pending = pending ? pending.then(save) : save();
        continue;
      }
      live.onEvent(event);
      continue;
    }
    trackAgentRow(live, event);
    if (event.type === "message.delta") {
      publishCodexText(live, "assistant", event.text, snapshot, itemId);
      continue;
    }
    if (event.type === "reasoning.delta") {
      publishCodexText(live, "reasoning", event.text, snapshot, itemId);
      continue;
    }
    live.onEvent(event);
  }
  if (method === "item/completed") showCodexAsyncQuestion(live, rec);
  // Metadata and steps can arrive before the spawn. Create its row first.
  let replay: Promise<void> | undefined;
  for (const childId of codexSubagentThreadIds(asRecord(rec?.item) ?? {})) {
    const owner = live.subagentThreads.get(childId);
    if (!owner) continue;
    const backlog = live.pendingSubagent.get(childId);
    live.pendingSubagent.delete(childId);
    for (const pendingStep of backlog ?? []) {
      const emit = () =>
        emitSubagentSteps(live, owner, pendingStep.method, pendingStep.params);
      if (replay) {
        replay = replay.then(emit);
      } else {
        const result = emit();
        if (result) replay = result;
      }
    }
  }
  const finish = () => {
    settleSubagentRows(live, rec);
    if (mapped.rateLimits) noteRateLimits(live, mapped.rateLimits);
    if (mapped.usageLimited) live.usageLimited = true;
    if (mapped.activeTurnId !== undefined) {
      live.activeTurnId = mapped.activeTurnId;
    }
    if (mapped.turnCompleted) {
      // Report the limit before the turn settles so queued follow-ups hold.
      if (live.usageLimited && !live.cancelled) {
        const resetsAt = usageLimitResetAt(live);
        live.onEvent({
          type: "usage.limited",
          ...(resetsAt != null ? { resetsAt } : {}),
        });
      }
      live.usageLimited = false;
      finishActiveTurn(live);
    }
  };
  const afterImages = () => {
    if (live.muteUpdates || live.cancelled) return;
    if (replay) return replay.then(finish);
    finish();
  };
  if (pending) return pending.then(afterImages);
  return afterImages();
}

function showCodexAsyncQuestion(
  live: Live,
  rec: Record<string, unknown> | null,
): void {
  const item = asRecord(rec?.item);
  const itemId = stringField(item, "id");
  const turnId = stringField(rec, "turnId") ?? live.activeTurnId;
  if (
    !itemId ||
    !turnId ||
    turnId !== live.activeTurnId ||
    live.emittedAsyncQuestions.has(itemId)
  )
    return;
  let questions;
  try {
    questions = codexAsyncQuestions(item);
  } catch (error) {
    live.onEvent({
      type: "status",
      text: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (!questions.length) return;
  live.emittedAsyncQuestions.add(itemId);
  const uiId = live.nextApprovalUiId++;
  const event: Extract<HarnessEvent, { type: "question.asked" }> = {
    type: "question.asked",
    requestId: uiId,
    title: questionPromptTitle(questions),
    questions,
    callId: itemId,
  };
  const outcome = new Promise<UserQuestionReply | "cancelled">((resolve) => {
    live.questions.set(uiId, {
      rpcId: null,
      threadId: live.threadId,
      turnId,
      event,
      isBlocking: false,
      resolve,
    });
  }).finally(() => {
    clearTimeout(live.questions.get(uiId)?.timer);
    live.questions.delete(uiId);
  });
  showNextQuestion(live);
  void outcome.then((reply) => {
    live.onEvent({
      type: "question.resolved",
      requestId: uiId,
      decision:
        reply === "cancelled"
          ? "cancelled"
          : reply.kind === "answered"
            ? "answered"
            : "skipped",
    });
    showNextQuestion(live);
  });
}

async function materializeGeneratedImage(
  live: Live,
  event: Extract<HarnessEvent, { type: "image.generated"; data: string }>,
): Promise<void> {
  const turnGeneration = live.turnGeneration;
  try {
    const asset = await saveGeneratedImage({
      data: event.data,
      name: event.name,
      ...(live.sessionId ? { sessionId: live.sessionId } : {}),
    });
    if (
      live.cancelled ||
      live.muteUpdates ||
      turnGeneration !== live.turnGeneration
    ) {
      void deleteGeneratedImages([asset.path]).catch(() => undefined);
      return;
    }
    live.onEvent({
      type: "image.generated",
      itemId: event.itemId,
      path: asset.path,
      name: event.name,
      mimeType: asset.mimeType,
      size: asset.size,
      ...(event.alt ? { alt: event.alt } : {}),
    });
  } catch (cause) {
    if (
      live.cancelled ||
      live.muteUpdates ||
      turnGeneration !== live.turnGeneration
    ) {
      return;
    }
    live.onEvent({
      type: "session.error",
      message: `Could not save generated image: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    });
  }
}

/** Rate-limit updates are sparse: a missing window keeps its last reading. */
function noteRateLimits(live: Live, update: Record<string, unknown>): void {
  const id = stringField(update, "limitId") ?? "";
  const current = live.rateLimits.get(id) ?? {};
  live.rateLimits.set(id, {
    primary: update.primary ?? current.primary,
    secondary: update.secondary ?? current.secondary,
  });
}

function usageLimitResetAt(live: Live): number | null {
  let latest: number | null = null;
  for (const windows of live.rateLimits.values()) {
    const resetsAt = exhaustedWindowResetAt(parseCodexRateLimits(windows));
    if (resetsAt != null) latest = Math.max(latest ?? 0, resetsAt);
  }
  return latest;
}

/**
 * How many notifications a not-yet-identified child thread may bank. Codex can
 * stream a subagent's first calls before the spawn item reports which thread it
 * created, and those calls are the most interesting ones — but an unrecognised
 * thread must not be able to grow this without bound.
 */
const MAX_PENDING_SUBAGENT = 64;

/**
 * Learns which agent row a child thread belongs to.
 * Returns true when every thread this item names already belongs to another
 * row, which makes the item a second description of an agent we already show.
 */
function bindSubagentThreads(
  live: Live,
  method: string,
  rec: Record<string, unknown> | null,
): boolean {
  if (method !== "item/started" && method !== "item/completed") return false;
  const item = asRecord(rec?.item);
  if (!item) return false;
  const itemType = stringField(item, "type") ?? "";
  if (itemType !== "subAgentActivity" && itemType !== "collabAgentToolCall") {
    return false;
  }
  const callId = stringField(item, "id");
  if (!callId) return false;
  const children = codexSubagentThreadIds(item).filter(
    (childId) => childId !== live.threadId,
  );
  let claimed = 0;
  for (const childId of children) {
    const owner = live.subagentThreads.get(childId);
    if (owner) {
      const model = stringField(item, "model");
      if (model && item.tool === "spawnAgent")
        live.onEvent({
          type: "tool.updated",
          callId: owner,
          kind: "agent",
          agentModel: model,
        });
      if (owner !== callId) claimed += 1;
      continue;
    }
    live.subagentThreads.set(childId, callId);
  }
  return children.length > 0 && claimed === children.length;
}

/**
 * An agent row for a child thread another row already owns. A failure still
 * gets its row — the reason a run died is the one thing worth a line of its
 * own — but a duplicate "running" or "done" is just noise.
 */
function duplicateAgentRow(event: HarnessEvent): boolean {
  if (event.type !== "tool.started" && event.type !== "tool.updated") {
    return false;
  }
  return event.kind === "agent" && event.status !== "failed";
}

/**
 * A child thread's notification. Until the spawn item says which row the thread
 * belongs to, keep it: dropping it loses the opening moves of the run.
 */
function handleSubagentNotification(
  live: Live,
  threadId: string,
  method: string,
  params: unknown,
): void | Promise<void> {
  const callId = live.subagentThreads.get(threadId);
  if (callId) {
    return emitSubagentSteps(live, callId, method, params);
  }
  if (!live.activeTurnId) return;
  if (
    method !== "item/started" &&
    method !== "item/completed" &&
    method !== "thread/started"
  )
    return;
  const backlog = live.pendingSubagent.get(threadId) ?? [];
  if (backlog.length >= MAX_PENDING_SUBAGENT) return;
  backlog.push({ method, params });
  live.pendingSubagent.set(threadId, backlog);
}

function emitSubagentSteps(
  live: Live,
  callId: string,
  method: string,
  params: unknown,
): void | Promise<void> {
  const image = mapCodexNotification(method, params).events.find(
    (event): event is Extract<HarnessEvent, { type: "image.generated" }> =>
      event.type === "image.generated",
  );
  if (image) {
    if (live.emittedGeneratedImages.has(image.itemId)) return;
    live.emittedGeneratedImages.add(image.itemId);
    if ("data" in image) return materializeGeneratedImage(live, image);
    live.onEvent(image);
    return;
  }
  for (const event of mapCodexSubagentSteps(callId, method, params)) {
    live.onEvent(event);
  }
}

/** Remembers an agent row while it runs, so the turn can close it out. */
function trackAgentRow(live: Live, event: HarnessEvent): void {
  if (event.type !== "tool.started" && event.type !== "tool.updated") return;
  if (event.kind !== "agent") return;
  if (event.status === "in_progress" || event.status === "pending") {
    live.openAgentRows.set(event.callId, event.title ?? "Subagent");
    return;
  }
  live.openAgentRows.delete(event.callId);
}

/**
 * Settles spawned agents from the per-agent state a collab item reports. The
 * spawn call returns immediately; this is the first word on whether the agent
 * it started actually finished.
 */
function settleSubagentRows(
  live: Live,
  rec: Record<string, unknown> | null,
): void {
  const item = asRecord(rec?.item);
  if (!item) return;
  for (const state of codexSubagentStates(item)) {
    const callId = live.subagentThreads.get(state.threadId);
    const title = callId ? live.openAgentRows.get(callId) : undefined;
    if (!callId || !title) continue;
    live.openAgentRows.delete(callId);
    live.onEvent({
      type: "tool.updated",
      callId,
      title,
      kind: "agent",
      status: state.status,
      ...(state.message ? { detail: state.message } : {}),
    });
  }
}

/**
 * A turn cannot end with an agent still working. Codex does not always report
 * a closing state for every child, and a row left running would hop forever.
 */
function closeOpenAgentRows(live: Live): void {
  for (const [callId, title] of live.openAgentRows) {
    live.onEvent({
      type: "tool.updated",
      callId,
      title,
      kind: "agent",
      status: "completed",
    });
  }
  live.openAgentRows.clear();
}

function publishCodexText(
  live: Live,
  role: "assistant" | "reasoning",
  text: string,
  snapshot: boolean,
  itemId: string | undefined,
): void {
  const emitted =
    role === "assistant"
      ? live.emittedAssistantByItem
      : live.emittedReasoningByItem;
  // Keep id-less notifications compatible without mixing them into known items.
  const key = itemId ?? "";
  const already = emitted.get(key) ?? "";
  const emit = snapshot ? snapshotRemainder(already, text) : text;
  if (!emit) return;
  // These are deltas (or a snapshot's missing suffix), so repeated tokens count.
  // Retain completed items until the turn ends to ignore repeated completions.
  emitted.set(key, already + emit);
  if (role === "assistant") {
    live.onEvent({ type: "message.delta", text: emit });
    return;
  }
  live.onEvent({ type: "reasoning.delta", text: emit });
}

function finishActiveTurn(live: Live, extraEvents: HarnessEvent[] = []): void {
  clearServerRequests(live);
  closeOpenAgentRows(live);
  live.turnEndPending = false;
  live.turnGeneration += 1;
  live.activeTurnId = null;
  live.emittedAssistantByItem.clear();
  live.emittedReasoningByItem.clear();
  live.emittedGeneratedImages.clear();
  live.emittedAsyncQuestions.clear();
  live.subagentThreads.clear();
  live.pendingSubagent.clear();
  for (const event of extraEvents) {
    live.onEvent(event);
  }
  const done = live.turnDone;
  const failed = live.turnFailed;
  live.turnDone = null;
  live.turnFailed = null;
  if (done) {
    done();
    return;
  }
  if (!failed) {
    live.turnEndPending = true;
  }
}

function settlePendingTurn(live: Live): void {
  if (!live.turnEndPending || !live.turnDone) return;
  finishActiveTurn(live);
}

async function handleServerRequest(
  live: Live,
  id: JsonRpcId,
  method: string,
  params: unknown,
): Promise<void> {
  const threadId = stringField(asRecord(params), "threadId") ?? live.threadId;
  if (method === "item/tool/requestUserInput") {
    if (live.cancelled || live.muteUpdates) {
      await live.rpc.respond(id, { answers: {} });
      return;
    }
    let questions;
    try {
      questions = codexQuestions(params);
    } catch (error) {
      live.onEvent({
        type: "status",
        text: error instanceof Error ? error.message : String(error),
      });
      await live.rpc.respond(id, { answers: {} });
      return;
    }
    const uiId = live.nextApprovalUiId++;
    const event: Extract<HarnessEvent, { type: "question.asked" }> = {
      type: "question.asked",
      requestId: uiId,
      title: questionPromptTitle(questions),
      questions,
      callId: stringField(asRecord(params), "itemId"),
    };
    const outcome = new Promise<UserQuestionReply | "cancelled">((resolve) => {
      live.questions.set(uiId, {
        rpcId: id,
        threadId,
        event,
        resolve,
        // Older servers omit this field and must keep their blocking behavior.
        isBlocking: asRecord(params)?.isBlocking !== false,
      });
    }).finally(() => {
      clearTimeout(live.questions.get(uiId)?.timer);
      live.questions.delete(uiId);
    });
    showNextQuestion(live);
    const reply = await outcome;
    live.onEvent({
      type: "question.resolved",
      requestId: uiId,
      decision:
        reply === "cancelled"
          ? "cancelled"
          : reply.kind === "answered"
            ? "answered"
            : "skipped",
    });
    showNextQuestion(live);
    if (reply !== "cancelled")
      await live.rpc.respond(id, codexQuestionResponse(questions, reply));
    return;
  }

  if (method === "mcpServer/elicitation/request") {
    const confirmation = codexMcpConfirmation(params);
    // A form or a browser sign-in: never answered without the user.
    if (
      !confirmation &&
      !live.cancelled &&
      !live.muteUpdates &&
      (await handleCodexSignIn_l5(live, id, threadId, params))
    )
      return;
    if (!confirmation || live.cancelled || live.muteUpdates) {
      if (!live.cancelled && !live.muteUpdates)
        live.onEvent({
          type: "status",
          text: "An MCP server sent a request MonoCode cannot show faithfully (an unsupported form field, a page that is not https, or a device check). It was cancelled. Complete it in the server's own interface.",
        });
      await live.rpc.respond(id, {
        action: "cancel",
        content: null,
        _meta: null,
      });
      return;
    }
    if (!live.planning && live.runtimeMode === "full-access") {
      await live.rpc.respond(id, {
        action: "accept",
        content: confirmation.content,
        _meta: null,
      });
      return;
    }
    const uiId = live.nextApprovalUiId++;
    const pending = waitApproval(live, uiId, id, "permissions", threadId);
    // MCP consent requires an explicit decision outside non-plan Full Access turns.
    live.onEvent({
      type: "approval.requested",
      requestId: uiId,
      kind: "other",
      title: confirmation.title,
    });
    const decision = await pending;
    live.onEvent({ type: "approval.resolved", requestId: uiId, decision });
    if (decision !== "cancelled")
      await live.rpc.respond(id, {
        action: decision === "allow" ? "accept" : "decline",
        content: decision === "allow" ? confirmation.content : null,
        _meta: null,
      });
    return;
  }

  const uiId = live.nextApprovalUiId++;
  const mapped = mapApprovalRequest(method, params, uiId);
  if (!mapped) {
    // An empty success or invented denial hides protocol incompatibility.
    live.onEvent({
      type: "status",
      text: `Unsupported Codex request: ${method}`,
    });
    await live.rpc.respondError(id, {
      code: -32601,
      message: `Unsupported method: ${method}`,
    });
    return;
  }

  if (live.planning || live.cancelled || live.muteUpdates) {
    // Plan turns run in a non-escalating read-only sandbox. If an older
    // app-server still asks for broader access, deny it silently instead of
    // leaking a Supervised approval prompt into the user's selected mode.
    if (method === "item/permissions/requestApproval") {
      await live.rpc.respond(id, { permissions: {} }).catch(() => undefined);
    } else {
      await live.rpc
        .respond(id, {
          decision: toCodexApprovalDecision("deny", mapped.kind),
        })
        .catch(() => undefined);
    }
    return;
  }

  if (method === "item/permissions/requestApproval") {
    // Auto-deny extra permission grants in supervised; allow in full-access.
    if (live.runtimeMode === "full-access") {
      const rec = asRecord(params);
      const permissions = rec?.permissions ?? {};
      await live.rpc.respond(id, {
        scope: "session",
        permissions,
      });
      return;
    }
    if (live.runtimeMode === "supervised") {
      const pending = waitApproval(live, uiId, id, mapped.kind, threadId);
      live.onEvent(mapped.event);
      const decision = await pending;
      live.onEvent({
        type: "approval.resolved",
        requestId: uiId,
        decision,
      });
      if (decision === "cancelled") return;
      if (decision === "allow") {
        const rec = asRecord(params);
        await live.rpc.respond(id, {
          scope: "turn",
          permissions: rec?.permissions ?? {},
        });
      } else {
        await live.rpc.respond(id, { permissions: {} });
      }
      return;
    }
    // auto / auto-accept: grant requested permissions for the turn.
    const rec = asRecord(params);
    await live.rpc.respond(id, {
      scope: "turn",
      permissions: rec?.permissions ?? {},
    });
    return;
  }

  // Per-chat rules for commands and patches. They sit below the plan branch
  // and the sandbox escalation above, which they never answer. "Never"
  // declines every such request. "Always" accepts only a plain patch: a
  // request that also asks for more access goes on to the mode and the user
  // below. It never accepts a command. Codex cannot be told to keep an
  // accepted command in its sandbox, and an escalation can look plain, so
  // "Always" on commands works through the turn's approval policy instead
  // (`commandsAlwaysPolicy`): Codex runs sandboxed commands without asking,
  // and what it still asks about is shown here.
  const toolKey = mapped.event.tool?.key;
  const rule = ruleDecision(live.toolRules, toolKey);
  // An automatic yes is held to the chat's folders: a file change outside
  // them, or one whose files are not known, goes to the card.
  const plain = isPlainCodexApproval(method, params);
  const ruleMayAccept = mapped.kind === "file-change" && plain;
  const insideFolders = () =>
    codexRequestInsideChatFolders_l5(
      live.fileChanges_l5,
      live.chatFolders_l5,
      method,
      params,
    );
  if (
    rule === "deny" ||
    (rule === "allow" && ruleMayAccept && (await insideFolders()))
  ) {
    await live.rpc.respond(id, {
      decision: toCodexApprovalDecision(rule, mapped.kind),
    });
    return;
  }

  const auto = autoApproval(live.runtimeMode, mapped.kind);
  if (auto) {
    await live.rpc.respond(id, {
      decision: toCodexApprovalDecision(auto, mapped.kind),
    });
    return;
  }

  const pending = waitApproval(live, uiId, id, mapped.kind, threadId, toolKey);
  // The entry exists once waitApproval returns. Keep it to read the user's
  // "Always allow <host>" pick after it resolves.
  const entry = live.approvals.get(uiId);
  if (entry && mapped.event.network?.amendments) {
    entry.networkAmendments = mapped.event.network.amendments;
  }
  if (entry) entry.sessionGrantOk = plain;
  live.onEvent(mapped.event);
  const decision = await pending;
  live.onEvent({
    type: "approval.resolved",
    requestId: uiId,
    decision,
  });
  if (decision === "cancelled") return;
  const amendment =
    decision === "allow" && mapped.kind === "command"
      ? entry?.chosenAmendment
      : undefined;
  // "Allow for this chat": Codex keeps the grant only for a plain request
  // whose files are inside the chat's folders. Otherwise it is a one-shot
  // accept, and the chat's own rule still checks the next request.
  const forSession =
    decision === "allow" &&
    !amendment &&
    Boolean(entry?.forChat && entry.sessionGrantOk) &&
    (await insideFolders());
  await live.rpc.respond(id, {
    decision: amendment
      ? codexNetworkAmendmentDecision_l5(amendment)
      : toCodexApprovalDecision(decision, mapped.kind, { forSession }),
  });
}

function waitApproval(
  live: Live,
  uiId: number,
  rpcId: JsonRpcId,
  kind: CodexApprovalKind,
  threadId: string,
  toolKey?: string,
): Promise<ApprovalOutcome> {
  return new Promise<ApprovalOutcome>((resolve) => {
    live.approvals.set(uiId, { rpcId, threadId, kind, toolKey, resolve });
  }).finally(() => {
    live.approvals.delete(uiId);
  });
}

function autoApproval(
  runtimeMode: RuntimeMode,
  kind: CodexApprovalKind,
): ApprovalDecision | null {
  if (runtimeMode === "supervised") return null;
  if (runtimeMode === "full-access") return "allow";
  if (runtimeMode === "auto") {
    // auto_review is set on the server; still prompt if Codex asks.
    return null;
  }
  // auto-accept-edits: auto file changes, ask for commands.
  if (kind === "file-change") return "allow";
  return null;
}

/** Exported for tests. */
export function __codexTestReset(): void {
  liveByThread.clear();
  resumeByThread.clear();
  cancelledThreads.clear();
  missingMcpNoted.clear();
}

export function __codexTestResumeMap(): Map<string, Resume> {
  return resumeByThread;
}
// [lane-1] exports
/**
 * The adapter's `forkSession`: `thread/fork` on the source thread, through
 * `lastTurnId` (inclusive) when given. Returns the new thread's id, which the
 * new chat is bound to. The source thread is left as it was.
 */
export async function forkCodexSession_l1(input: {
  source: HarnessSessionInput;
  boundary?: string;
}): Promise<{ providerSessionId?: string }> {
  if (input.source.ephemeral) {
    throw new Error("This chat keeps no Codex thread to fork");
  }
  const live = await ensureLive(input.source);
  await live.turns.catch(() => undefined);
  if (live.activeTurnId) {
    throw new Error("Stop the current turn before forking");
  }
  const response = await live.rpc.request<unknown>("thread/fork", {
    threadId: live.threadId,
    ...(input.boundary ? { lastTurnId: input.boundary } : {}),
  });
  const thread = asRecord(asRecord(response)?.thread);
  const id = stringField(thread, "id");
  if (!id || id === live.threadId) {
    throw new Error("Codex did not return a new thread for the fork");
  }
  return { providerSessionId: id };
}
/**
 * The connection and thread of a live Codex session, for calls made beside
 * the turn (background terminals, fork). Null when no app-server is up.
 */
export function codexLiveThread_l1(
  sessionId: string,
): { rpc: JsonRpcClient; threadId: string } | null {
  const live = liveByThread.get(sessionId);
  if (!live || !live.threadId) return null;
  return { rpc: live.rpc, threadId: live.threadId };
}
// [lane-2] exports
// [lane-3] exports
// [lane-4] exports
// [lane-5] exports
/**
 * Read before a notification is queued: the paths of file change items, for
 * the chat-folder check, and the images of finished MCP tool calls, such as
 * browser screenshots, kept for the transcript as Claude Code's are.
 */
function noteCodexNotification_l5(
  live: Live,
  sessionId: string,
  method: string,
  params: unknown,
): void {
  recordCodexFileChange_l5(live.fileChanges_l5, method, params);
  if (live.muteUpdates || live.cancelled) return;
  const found = codexMcpResultImages_l5(method, params, live.threadId);
  if (!found) return;
  void keepToolResultImages_l5({
    sessionId,
    callId: found.callId,
    images: found.images,
    emit: (event) => live.onEvent(event),
    wanted: () => liveByThread.get(sessionId) === live,
  });
}
/**
 * MCP sign-in requests: a form gets a question card, a browser request gets a
 * card that opens the page on the user's click. Returns false when the
 * request is neither, so the caller cancels it with a note.
 */
async function handleCodexSignIn_l5(
  live: Live,
  id: JsonRpcId,
  threadId: string,
  params: unknown,
): Promise<boolean> {
  const form = codexElicitationForm_l5(params);
  if (form) {
    const uiId = live.nextApprovalUiId++;
    const event: Extract<HarnessEvent, { type: "question.asked" }> = {
      type: "question.asked",
      requestId: uiId,
      title: `${form.server} (MCP server) asks: ${form.message}`,
      questions: form.questions,
    };
    const outcome = new Promise<UserQuestionReply | "cancelled">((resolve) => {
      // Blocking, so no timer ever skips it.
      live.questions.set(uiId, {
        rpcId: id,
        threadId,
        event,
        resolve,
        isBlocking: true,
      });
    }).finally(() => {
      clearTimeout(live.questions.get(uiId)?.timer);
      live.questions.delete(uiId);
    });
    showNextQuestion(live);
    const reply = await outcome;
    live.onEvent({
      type: "question.resolved",
      requestId: uiId,
      decision:
        reply === "cancelled"
          ? "cancelled"
          : reply.kind === "answered"
            ? "answered"
            : "skipped",
    });
    showNextQuestion(live);
    if (reply === "cancelled") return true;
    if (reply.kind === "skipped") {
      await live.rpc.respond(id, {
        action: "decline",
        content: null,
        _meta: null,
      });
      return true;
    }
    const answer = codexElicitationContent_l5(form, reply);
    if (!answer.ok)
      live.onEvent({
        type: "status",
        text: `The answer was not sent to ${form.server}: ${answer.error}.`,
      });
    await live.rpc.respond(
      id,
      answer.ok
        ? { action: "accept", content: answer.content, _meta: null }
        : { action: "decline", content: null, _meta: null },
    );
    return true;
  }
  const signIn = codexElicitationSignIn_l5(params);
  if (!signIn) return false;
  const uiId = live.nextApprovalUiId++;
  const pending = waitApproval(live, uiId, id, "permissions", threadId);
  live.onEvent({
    type: "approval.requested",
    requestId: uiId,
    title: `${signIn.server} (MCP server) asks you to sign in at ${signIn.host}`,
    kind: "other",
    signIn,
  });
  const decision = await pending;
  live.onEvent({ type: "approval.resolved", requestId: uiId, decision });
  if (decision === "cancelled") return true;
  // Accept means the user opened the page. The server finishes on its own.
  await live.rpc.respond(id, {
    action: decision === "allow" ? "accept" : "decline",
    content: null,
    _meta: null,
  });
  return true;
}
/**
 * Keep the chat's folders current: a folder added mid-session applies from
 * the next turn. Spread into the `turn/start` params, where it adds nothing.
 */
function noteCodexChatFolders_l5(
  live: Live,
  extraDirs: string[] | undefined,
): Record<string, never> {
  live.chatFolders_l5 = chatFolders_l5(live.cwd, extraDirs);
  return {};
}
