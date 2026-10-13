import { TurnNotReadyError } from "../../core/types";
import type {
  RewindLastTurnInput,
  RewindLastTurnResult,
} from "../../core/types";
import { nativeModelId } from "../../../../features/sessions/model/models";
import { sameProviderAccountId } from "../../../../features/providers/model/providerAccounts";
import type {
  ApprovalTool,
  RuntimeMode,
  TaskListItem,
  TaskListMeta,
} from "../../../../features/sessions/model/session";
import { loadClaudeHooks } from "../../../../features/settings/model/settings";
import {
  killChild,
  resolveClaudeBinary,
  spawnChild,
  unwatchChild,
  watchChild,
  writeChild,
} from "../../core/child";
import {
  askUserQuestionAllowInput,
  asRecord,
  assistantMessageId,
  assistantTextBlocks,
  assistantThinkingBlocks,
  assistantToolUses,
  contextFromResult,
  contextUsedFromAssistant,
  turnMetricsFromResult,
  buildClaudeSpawnArgs,
  buildClaudeUserMessage,
  buildControlRequest,
  buildControlResponse,
  claudeBlockedToolMessage,
  claudeSettingsKey,
  claudeSkillDenyRules,
  claudeToolDenyRules,
  extractAskUserQuestionTitle,
  extractExitPlanModePlan,
  initMcpServers,
  inputJsonDeltaFromEvent,
  isAgentTaskType,
  isClaudeUltracodeEffort,
  isSubagentMessage,
  isTerminalAgentTaskStatus,
  isTodoTool,
  applyClaudeTaskTool,
  isUsageLimitResult,
  normalizeClaudeCliEffort,
  parseBackgroundTasks,
  parseControlCancelId,
  parseControlRequest,
  parseJsonLine,
  parseTaskNotification,
  parseTaskProgress,
  parseTaskStarted,
  parseTaskUpdated,
  parseToolProgress,
  taskListFromTodos,
  previewFromTool,
  bashCommandField,
  resolveClaudeApiModelId,
  runtimeModeToPermission,
  sessionIdFromMessage,
  statusTextFromSystem,
  streamDeltaFromEvent,
  stringField,
  summarizeToolRequest,
  toClaudePermissionResult,
  toolKindFromName,
  toolResultsFromUserMessage,
  toolStartFromEvent,
  toolTitle,
  tryParseJsonRecord,
  turnStatusFromResult,
  usageLimitFromRateLimitEvent,
  type ClaudeAgentTaskNotification,
  type ClaudeCliSettings,
  type ClaudeControlRequest,
} from "./claudeProtocol";
import { existingDirs } from "../../core/existingDirs";
import { readClaudeLastEntry } from "./claudeLastEntry";
import { toolRules, type ToolRules } from "../../core/toolRules";
import { noteReportedMcpServers } from "../../../../features/session-tools/model/reportedMcpServers";
import { keepToolResultImages } from "../../../../features/tool-images/data/toolImageStore";
import type { ToolResultImage } from "../../../../features/tool-images/model/toolImages";
import { isAgentToolName } from "../../core/preview";
import { joinStreamText, snapshotRemainder } from "../../core/streamText";
import {
  questionPromptTitle,
  questionsFromUnknown,
  type UserQuestionReply,
} from "../../../../features/sessions/model/userQuestion";
import { approvalTool } from "../../../../features/tool-access/model/toolAccess";
import {
  commandRuleGate,
  packageScriptFingerprint,
  ruleHeldToProjectScripts,
} from "../../../../features/tool-access/model/commandRuleGate";
import { recordScriptRuleFingerprint } from "../../../../features/tool-access/model/scriptRuleStore";
import {
  COMMAND_RULE_TOOL,
  commandRuleForRequest,
  commandRuleFromKey,
  commandRuleKey,
  packageScriptOf,
  isCompoundCommand,
  deriveCommandRule,
  matchingCommandRule,
} from "../../../../features/tool-access/model/commandRules";
import { claudePluginOverrides } from "../../../../features/claude-plugins/model/chatPlugins";
import type {
  ApprovalDecision,
  CompactContextInput,
  HarnessEvent,
  HarnessSessionInput,
  HarnessToolAccess,
  SendTurnInput,
  SteerTurnInput,
} from "../../core/types";
// [lane-1] imports
import { claudeBackgroundItems as claudeBackgroundItems_l1 } from "./claudeBackground";
import { backgroundItemsKey as backgroundItemsKey_l1 } from "../../core/background";
// [lane-2] imports
import { agentsMdPluginConfig as agentsMdPluginConfig_l2 } from "../../../../features/project-context/model/instructions";
// [lane-3] imports
// [lane-4] imports
import { loadClaudeToolLoading as loadClaudeToolLoading_l4 } from "../../../../features/gateway-connectors/model/toolLoading";
// [lane-5] imports
import {
  chatFolders as chatFolders_l5,
  claudeWritePath as claudeWritePath_l5,
  pathsInsideChatFolders as pathsInsideChatFolders_l5,
} from "../../../../features/tool-access/model/chatFolders";
import {
  blockedFetchMessage as blockedFetchMessage_l5,
  blockedSiteMessage as blockedSiteMessage_l5,
  siteApprovalRequest as siteApprovalRequest_l5,
} from "../../../../features/browser-tools/model/browserTools";
import { siteRule as siteRule_l5 } from "../../../../features/browser-tools/model/siteRules";

/**
 * A PermissionRequest hook can decide before the user touches the prompt; Claude
 * then cancels the control request out from under us. That is not a rejection,
 * so it gets its own outcome instead of being folded into "deny".
 */
type ApprovalOutcome = ApprovalDecision | "cancelled";

type PendingApproval = {
  requestId: string;
  /** Claude Code's name for the tool, as the per-chat rules key it. */
  toolName: string;
  input: Record<string, unknown>;
  resolve: (decision: ApprovalOutcome) => void;
  /**
   * The package script fingerprint "Allow for this chat" keeps with the
   * card's rule, read when the card was shown (security fix R3).
   */
  scriptPrint?: Promise<{ ruleKey: string; fingerprint: string } | undefined>;
};

type PendingQuestion = {
  requestId: string;
  event: Extract<HarnessEvent, { type: "question.asked" }>;
  resolve: (reply: UserQuestionReply | "cancelled") => void;
};

type InFlightTool = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  partialJson: string;
  title: string;
};

type LiveAgentTask = {
  taskId: string;
  toolUseId?: string;
  description: string;
  backgrounded: boolean;
};

type BackgroundTask = {
  description: string;
  toolUseId?: string;
  /** Claude Code's `task_type`, which tells a subagent from a shell. */
  taskType?: string;
  /** When MonoCode first heard of it, epoch ms. */
  startedAt?: number;
};

type Live = {
  cwd: string;
  claudeSessionId: string;
  /**
   * A new conversation that has not been sent a prompt yet. The first prompt
   * has nothing before it to cut back to.
   */
  fresh: boolean;
  /** The process has gone. */
  exited: boolean;
  /** Started cut back to an earlier entry, and not sent a prompt since. */
  cutPending: boolean;
  providerAccountId?: string;
  runtimeMode: RuntimeMode;
  planning: boolean;
  settingsKey: string;
  /**
   * The chat's per-tool rules. Set from each turn's input, and replaced in
   * between by `setClaudeToolAccess` when the user changes a rule.
   */
  toolRules: ToolRules;
  onEvent: (event: HarnessEvent) => void;
  approvals: Map<number, PendingApproval>;
  questions: Map<number, PendingQuestion>;
  visibleQuestionId: number | null;
  nextApprovalUiId: number;
  nextControlId: number;
  toolsByIndex: Map<number, InFlightTool>;
  toolsById: Map<string, InFlightTool>;
  agentTasks: Map<string, LiveAgentTask>;
  /**
   * Every task Claude still runs for this session, by id: subagents, shells it
   * backgrounded, monitors. Each one ends in a notification that wakes Claude
   * for another turn, so the MonoCode turn stays open until they are done.
   */
  backgroundTasks: Map<string, BackgroundTask>;
  /** Rows shown for tasks still running when Claude yielded, by task id. */
  backgroundRows: Map<string, string>;
  /** A task finished after Claude yielded; its follow-up turn is on the way. */
  awaitingResume: ReturnType<typeof setTimeout> | null;
  /** Last background list sent to the UI, to skip repeats. */
  backgroundKey: string;
  /** Finished-subagent notes held until Claude picks the thread back up. */
  taskNotes: string[];
  /** TaskCreate/TaskUpdate items, keyed by Claude's task id. */
  claudeTasks: Map<string, TaskListItem>;
  turnResultSeen: boolean;
  /** Latest `rate_limit_event` refused requests; reported when the turn ends. */
  usageLimit: { resetsAt?: number } | null;
  cancelled: boolean;
  muteUpdates: boolean;
  turns: Promise<void>;
  turnDone: (() => void) | null;
  turnFailed: ((error: Error) => void) | null;
  turnEndPending: boolean;
  activeTurn: boolean;
  initDone: (() => void) | null;
  initialized: boolean;
  emittedAssistant: string;
  emittedReasoning: string;
  pendingAssistantBoundary: boolean;
  manualCompaction: boolean;
  compactionConfirmed: boolean;
  // [lane-1] live
  /** Last Running list sent to the UI, to skip repeats. */
  backgroundItemsKey_l1: string;
  // [lane-2] live
  // [lane-3] live
  // [lane-4] live
  // [lane-5] live
  /** The chat's working folder and added folders, for automatic yeses. */
  chatFolders_l5: string[];
};

type Resume = {
  sessionId: string;
  cwd: string;
  providerAccountId?: string;
  /**
   * False for a conversation that was started and has not been sent a prompt:
   * Claude Code has nothing saved under its id yet, so it cannot be resumed.
   */
  prompted?: boolean;
};

const INIT_TIMEOUT_MS = 8_000;
/**
 * How long a rewind waits for Claude Code to start cut back. It loads the
 * whole conversation first, which takes longer than a plain start on a long
 * chat. Kept under the menu's own limit (45 s) so a slow start fails here,
 * where the conversation can be put back, rather than in the menu.
 */
export const REWIND_INIT_TIMEOUT_MS = 30_000;
/**
 * How long a finished background task may take to wake Claude before the turn
 * is let go anyway. The follow-up turn normally starts within a second or two.
 */
const RESUME_GRACE_MS = 15_000;

const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, Resume>();
/**
 * Claude task lists outlive a Live: a restart that resumes the conversation
 * keeps its task ids, so later TaskUpdate calls must find earlier tasks. Task
 * ids belong to one Claude conversation, so each map records which one.
 */
const tasksByThread = new Map<
  string,
  { providerSessionId: string; tasks: Map<string, TaskListItem> }
>();
/** Task-list block key for TaskCreate/TaskUpdate items. */
const CLAUDE_TASKS_KEY = "claude-tasks";
const cancelledThreads = new Set<string>();
/**
 * The newest entry of each thread's Claude conversation, as far as this run of
 * the app has seen it: the uuid Claude gave the last message or tool result on
 * the main chain. A prompt sent now follows that entry, so it is where the
 * conversation is cut to take the prompt back. It outlives a Live, since a
 * restart for a new model or folder resumes the same conversation.
 */
const lastEntryByThread = new Map<
  string,
  {
    providerSessionId: string;
    uuid: string;
    /**
     * A prompt has been sent after this entry and nothing has come back yet.
     * A second prompt sent now follows the first, whose uuid is not known.
     */
    claimed: boolean;
    /**
     * The turn after this entry was stopped. Claude Code then writes entries
     * of its own that it does not stream (the stopped calls' results and the
     * interrupt note), so this is no longer where its conversation ends.
     * Cutting back to it would leave a stopped call unanswered, and Claude
     * Code would run it again in the resumed conversation (Mac 11.T2.8).
     */
    stale?: boolean;
  }
>();
/** A cut asked for by an edit, for the next start of that conversation. */
const rewindByThread = new Map<
  string,
  { providerSessionId: string; at: string }
>();
/**
 * The boundary of a conversation's first prompt. There is no entry before it
 * to cut back to, so taking it back starts a new conversation.
 */
export const CLAUDE_FIRST_TURN = "claude-first-turn";

let resolveClaudeBinaryImpl: () => Promise<{ path: string }> =
  resolveClaudeBinary;

/** Test seam. */
export function setClaudeBinaryResolver(
  fn: () => Promise<{ path: string }>,
): void {
  resolveClaudeBinaryImpl = fn;
}

export async function sendClaudeTurn(input: SendTurnInput): Promise<void> {
  let live: Live;
  try {
    live = await ensureLive(input);
  } catch (error) {
    cancelledThreads.delete(input.sessionId);
    throw error;
  }
  if (cancelledThreads.delete(input.sessionId)) return;

  live.onEvent = input.onEvent;
  live.runtimeMode = input.runtimeMode;
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
      live.cancelled = false;
      live.muteUpdates = false;
      await refreshStaleEntry(input.sessionId, live);
      if (live.cancelled) return;
      try {
        await runTurn(live, input);
      } catch (error) {
        if (live.cancelled) return;
        throw error;
      }
    });
  await live.turns;
}

export async function compactClaudeContext(
  input: CompactContextInput,
): Promise<void> {
  const settingsKey = settingsKeyFor(input);
  let live = liveByThread.get(input.sessionId);
  if (!live || live.cwd !== input.cwd || live.settingsKey !== settingsKey) {
    live = await ensureLive(input);
  }
  if (cancelledThreads.delete(input.sessionId)) return;

  live.onEvent = input.onEvent;
  live.runtimeMode = input.runtimeMode;
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
      live.cancelled = false;
      live.muteUpdates = false;
      live.manualCompaction = true;
      live.compactionConfirmed = false;
      try {
        await runTurn(live, {
          ...input,
          modelSettings: undefined,
          text: "/compact",
          attachments: [],
        });
        if (!live.compactionConfirmed) {
          throw new Error("Claude Code did not confirm context compaction");
        }
      } catch (error) {
        if (live.cancelled) return;
        throw error;
      } finally {
        live.manualCompaction = false;
      }
    });
  await live.turns;
}

export async function steerClaudeTurn(input: SteerTurnInput): Promise<void> {
  const live = liveByThread.get(input.sessionId);
  if (!live?.activeTurn) throw new TurnNotReadyError("No active turn to steer");

  const message = buildClaudeUserMessage({
    text: input.text,
    attachments: input.attachments,
    effort: input.modelSettings?.effort,
  });
  const content = (message.message as { content: unknown[] }).content;
  if (content.length === 0) return;

  await writeJson(input.sessionId, message);
}

export function respondClaudeApproval(
  sessionId: string,
  requestId: number,
  decision: ApprovalDecision,
  options?: { forChat?: boolean },
): void {
  const live = liveByThread.get(sessionId);
  const pending = live?.approvals.get(requestId);
  if (!pending) return;
  const print = pending.scriptPrint;
  if (decision === "allow" && options?.forChat && print) {
    // The fingerprint is kept before Claude Code hears the answer, so its
    // next request already meets it.
    void print
      .then((found) => {
        if (found)
          recordScriptRuleFingerprint(
            sessionId,
            found.ruleKey,
            found.fingerprint,
          );
      })
      .finally(() => pending.resolve(decision));
    return;
  }
  pending.resolve(decision);
}

/**
 * Replace a live session's per-tool rules, so a rule the user sets while a
 * turn runs answers the next request without waiting for the next turn. A
 * card already on screen for a tool that is now blocked is declined. One for
 * a tool that is now always allowed stays: the user has seen that request and
 * answers it.
 *
 * A blocked tool only leaves the model's tool list when the process next
 * starts (`--disallowedTools`). Until then this can refuse only the calls
 * Claude Code asks about, which leaves out what the permission mode or the
 * user's own Claude Code settings already allow.
 */
export function setClaudeToolAccess(
  sessionId: string,
  access?: HarnessToolAccess,
): void {
  const live = liveByThread.get(sessionId);
  if (!live) return;
  live.toolRules = toolRules(access);
  for (const pending of [...live.approvals.values()]) {
    if (live.toolRules.never.has(pending.toolName)) pending.resolve("deny");
  }
}

export function respondClaudeQuestion(
  sessionId: string,
  requestId: number,
  reply: UserQuestionReply,
): void {
  const live = liveByThread.get(sessionId);
  const pending = live?.questions.get(requestId);
  if (!pending) return;
  pending.resolve(reply);
}

export async function cancelClaudeTurn(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  if (!live) {
    cancelledThreads.add(sessionId);
    return;
  }
  live.cancelled = true;
  live.muteUpdates = true;
  for (const [, pending] of live.approvals) pending.resolve("deny");
  live.approvals.clear();
  for (const [, pending] of live.questions)
    pending.resolve({ kind: "skipped" });
  live.questions.clear();
  // Stop means the whole run, including what Claude left going in the
  // background. Otherwise it finishes later and wakes Claude up again.
  for (const taskId of live.backgroundTasks.keys()) {
    await writeJson(
      sessionId,
      buildControlRequest(nextControlId(live), {
        subtype: "stop_task",
        task_id: taskId,
      }),
    ).catch(() => undefined);
  }
  await writeJson(
    sessionId,
    buildControlRequest(nextControlId(live), { subtype: "interrupt" }),
  ).catch(() => undefined);
  const last = lastEntryByThread.get(sessionId);
  if (last) last.stale = true;
  finishActiveTurn(live, [
    { type: "message.completed" },
    { type: "reasoning.completed" },
  ]);
}

export async function stopClaudeSession(sessionId: string): Promise<void> {
  cancelledThreads.delete(sessionId);
  const live = liveByThread.get(sessionId);
  liveByThread.delete(sessionId);
  if (live) {
    live.muteUpdates = true;
    for (const [, pending] of live.approvals) pending.resolve("deny");
    live.approvals.clear();
    for (const [, pending] of live.questions)
      pending.resolve({ kind: "skipped" });
    live.questions.clear();
    live.activeTurn = false;
    live.turnDone?.();
    live.turnDone = null;
    live.turnFailed = null;
    live.initDone?.();
    live.initDone = null;
  }
  unwatchChild(sessionId);
  await killChild(sessionId).catch(() => undefined);
}

export async function forgetClaudeSession(sessionId: string): Promise<void> {
  resumeByThread.delete(sessionId);
  tasksByThread.delete(sessionId);
  lastEntryByThread.delete(sessionId);
  rewindByThread.delete(sessionId);
  await stopClaudeSession(sessionId);
}

/**
 * Takes the last prompt back out of Claude's conversation, so an edited one
 * can be sent in its place. Claude Code cannot drop a turn from a running
 * process. It can start again from an earlier point of the same conversation
 * (`--resume` with `--resume-session-at`), so this stops the process and
 * starts one cut back to the entry the prompt followed. `providerTurnId` is
 * that entry, recorded when the prompt was sent.
 *
 * Files the turn changed are left as they are. Claude's later entries stay in
 * its session file as an abandoned branch.
 */
export async function rewindClaudeLastTurn(
  input: RewindLastTurnInput,
): Promise<RewindLastTurnResult> {
  const threadId = input.sessionId;
  const boundary = input.providerTurnId?.trim();
  if (!boundary) {
    throw new Error(
      "This message cannot be edited: its place in the Claude conversation is not known",
    );
  }
  if (liveByThread.get(threadId)?.activeTurn) {
    throw new Error("Stop the current turn before editing the last message");
  }
  const firstTurn = boundary === CLAUDE_FIRST_TURN;
  // What to put back if Claude Code will not start from the cut: the app
  // keeps its transcript then, and the conversation has to match it.
  const before = {
    resume: resumeByThread.get(threadId),
    tasks: tasksByThread.get(threadId),
    lastEntry: lastEntryByThread.get(threadId),
  };
  if (!firstTurn && !before.resume) {
    throw new Error(
      "This message cannot be edited: there is no Claude conversation to go back in",
    );
  }
  const restore = async () => {
    await stopClaudeSession(threadId);
    rewindByThread.delete(threadId);
    setOrDelete(resumeByThread, threadId, before.resume);
    setOrDelete(tasksByThread, threadId, before.tasks);
    setOrDelete(lastEntryByThread, threadId, before.lastEntry);
  };

  await stopClaudeSession(threadId);
  if (firstTurn) {
    // Nothing came before the prompt: the edit opens a new conversation.
    resumeByThread.delete(threadId);
    tasksByThread.delete(threadId);
    lastEntryByThread.delete(threadId);
    rewindByThread.delete(threadId);
  } else if (before.resume) {
    rewindByThread.set(threadId, {
      providerSessionId: before.resume.sessionId,
      at: boundary,
    });
  }

  let live: Live;
  try {
    live = await ensureLive(input, REWIND_INIT_TIMEOUT_MS);
  } catch (error) {
    cancelledThreads.delete(threadId);
    await restore();
    throw error;
  }
  cancelledThreads.delete(threadId);
  // Claude Code loads the conversation before it answers anything, and exits
  // when it cannot find the entry to cut back to. Starting does not wait on
  // either, so look before telling the app the prompt is gone.
  if (live.exited || liveByThread.get(threadId) !== live) {
    await restore();
    throw new Error("Claude Code could not go back to before this message");
  }
  if (!live.initialized) {
    await restore();
    throw new Error(
      "Claude Code did not start in time to edit this message. Try again",
    );
  }
  if (!firstTurn && !live.cutPending) {
    // The conversation could not be resumed here at all, in another folder
    // or under another account, so there was nothing to cut.
    await restore();
    throw new Error(
      "This message cannot be edited: its Claude conversation cannot be resumed here",
    );
  }
  if (!firstTurn) {
    // The edited prompt follows the same entry the old one did.
    lastEntryByThread.set(threadId, {
      providerSessionId: live.claudeSessionId,
      uuid: boundary,
      claimed: false,
    });
  }
  return { submitted: false };
}

function setOrDelete<V>(
  map: Map<string, V>,
  key: string,
  value: V | undefined,
) {
  if (value === undefined) map.delete(key);
  else map.set(key, value);
}

export function bindClaudeSession(
  threadId: string,
  providerSessionId: string,
  cwd: string,
  providerAccountId?: string,
): void {
  const sessionId = providerSessionId.trim();
  if (!threadId || !sessionId || !cwd.trim()) return;
  resumeByThread.set(threadId, { sessionId, cwd, providerAccountId });
  // Task ids from another conversation mean nothing in this one.
  if (tasksByThread.get(threadId)?.providerSessionId !== sessionId) {
    tasksByThread.delete(threadId);
  }
}

/**
 * Seed the task map from a restored session's persisted panel. After an app
 * restart only the transcript survives, and a resumed conversation still
 * refers to its earlier task ids.
 */
export function restoreClaudeTaskLists(
  threadId: string,
  lists: TaskListMeta[],
): void {
  if (!threadId || tasksByThread.has(threadId)) return;
  // Only a list produced by the conversation bound to this thread applies.
  const providerSessionId = resumeByThread.get(threadId)?.sessionId;
  if (!providerSessionId) return;
  let items: TaskListItem[] = [];
  for (const entry of lists) {
    if (entry.key !== CLAUDE_TASKS_KEY) continue;
    if (entry.providerSessionId !== providerSessionId) continue;
    items = entry.items.filter((item) => item.id);
  }
  if (items.length === 0) return;
  tasksByThread.set(threadId, {
    providerSessionId,
    tasks: new Map(items.map((item) => [item.id!, { ...item }])),
  });
}

async function ensureLive(
  input: HarnessSessionInput,
  initTimeoutMs: number = INIT_TIMEOUT_MS,
): Promise<Live> {
  const settingsKey = settingsKeyFor(input);
  const planning = input.intent === "plan";
  const existing = liveByThread.get(input.sessionId);
  if (
    existing &&
    existing.cwd === input.cwd &&
    existing.settingsKey === settingsKey &&
    existing.planning === planning
  ) {
    existing.onEvent = input.onEvent;
    existing.runtimeMode = input.runtimeMode;
    existing.toolRules = toolRules(input.toolAccess);
    return existing;
  }
  if (existing) {
    // Model and launch-setting changes require a fresh Claude process, but
    // they must resume the same provider conversation. Only a cwd change
    // invalidates the stored session because Claude sessions are cwd-bound.
    if (existing.cwd !== input.cwd) resumeByThread.delete(input.sessionId);
    await stopClaudeSession(input.sessionId);
  }

  const resume = resumeByThread.get(input.sessionId);
  const canResume =
    resume != null &&
    resume.prompted !== false &&
    resume.cwd === input.cwd &&
    sameProviderAccountId(resume.providerAccountId, input.providerAccountId);
  if (
    resume &&
    (resume.prompted === false ||
      resume.cwd !== input.cwd ||
      !sameProviderAccountId(resume.providerAccountId, input.providerAccountId))
  ) {
    resumeByThread.delete(input.sessionId);
  }
  const { path } = await resolveClaudeBinaryImpl();
  const liveRef: { current: Live | null } = { current: null };
  const claudeSessionId =
    canResume && resume ? resume.sessionId : crypto.randomUUID();
  const retained = tasksByThread.get(input.sessionId);
  const claudeTasks =
    retained?.providerSessionId === claudeSessionId
      ? retained.tasks
      : new Map<string, TaskListItem>();
  tasksByThread.set(input.sessionId, {
    providerSessionId: claudeSessionId,
    tasks: claudeTasks,
  });
  // A cut stays asked for until a prompt has been sent on the cut
  // conversation. Until then Claude's file still ends where it did, and a
  // plain resume would bring the prompt back.
  const rewind = rewindByThread.get(input.sessionId);
  const resumeAt =
    canResume && rewind?.providerSessionId === resume?.sessionId
      ? rewind?.at
      : undefined;
  if (!resumeAt) rewindByThread.delete(input.sessionId);
  const launch = launchOptions(
    input,
    canResume ? resume?.sessionId : undefined,
    claudeSessionId,
    // Claude Code checks each folder at startup; one that is gone stays off
    // the command line instead of failing the launch.
    await existingDirs(input.extraDirs),
    resumeAt,
  );
  if (
    lastEntryByThread.get(input.sessionId)?.providerSessionId !==
    claudeSessionId
  ) {
    lastEntryByThread.delete(input.sessionId);
  }
  // A conversation resumed after an app restart has streamed nothing in this
  // run, so its next prompt had no place to be cut back to and could not be
  // rewound (1.6). Its transcript's last entry is that place. Not for a cut
  // or a fork: a cut sets its own entry, and a fork's copy gets new ids.
  if (
    canResume &&
    !resumeAt &&
    !lastEntryByThread.has(input.sessionId) &&
    forkByThread_l1.get(input.sessionId) !== claudeSessionId
  ) {
    const uuid = await readClaudeLastEntry({
      cwd: input.cwd,
      sessionId: claudeSessionId,
      providerAccountId: input.providerAccountId,
    });
    if (uuid && !lastEntryByThread.has(input.sessionId)) {
      lastEntryByThread.set(input.sessionId, {
        providerSessionId: claudeSessionId,
        uuid,
        claimed: false,
      });
    }
  }

  const live: Live = {
    cwd: input.cwd,
    claudeSessionId,
    fresh: !canResume,
    exited: false,
    cutPending: !!resumeAt,
    providerAccountId: input.providerAccountId,
    runtimeMode: input.runtimeMode,
    planning,
    settingsKey,
    toolRules: toolRules(input.toolAccess),
    onEvent: input.onEvent,
    approvals: new Map(),
    questions: new Map(),
    visibleQuestionId: null,
    nextApprovalUiId: 1,
    nextControlId: 1,
    toolsByIndex: new Map(),
    toolsById: new Map(),
    agentTasks: new Map(),
    backgroundTasks: new Map(),
    backgroundRows: new Map(),
    awaitingResume: null,
    backgroundKey: "",
    taskNotes: [],
    claudeTasks,
    turnResultSeen: false,
    usageLimit: null,
    cancelled: false,
    muteUpdates: false,
    turns: Promise.resolve(),
    turnDone: null,
    turnFailed: null,
    turnEndPending: false,
    activeTurn: false,
    initDone: null,
    initialized: false,
    emittedAssistant: "",
    emittedReasoning: "",
    pendingAssistantBoundary: false,
    manualCompaction: false,
    compactionConfirmed: false,
    // [lane-1] live-init
    backgroundItemsKey_l1: "",
    // [lane-2] live-init
    // [lane-3] live-init
    // [lane-4] live-init
    // [lane-5] live-init
    chatFolders_l5: chatFolders_l5(input.cwd, input.extraDirs),
  };
  liveRef.current = live;

  watchChild(
    input.sessionId,
    (line) => {
      const current = liveRef.current;
      if (!current) return;
      handleLine(input.sessionId, current, line);
    },
    (code) => {
      liveByThread.delete(input.sessionId);
      const current = liveRef.current;
      if (current) {
        current.exited = true;
        // A cut Claude Code would not start from must not be asked for again
        // on every later start. One it did start from, and then died before
        // a prompt was sent, is still owed.
        if (current.cutPending && !current.initialized) {
          rewindByThread.delete(input.sessionId);
        }
      }
      if (!current?.muteUpdates) {
        (current?.onEvent ?? input.onEvent)({ type: "session.ended", code });
      }
      current?.turnFailed?.(new Error("Claude Code exited"));
      current?.initDone?.();
      if (current) {
        current.turnDone = null;
        current.turnFailed = null;
        current.initDone = null;
      }
    },
  );

  // [lane-1] ensure-live
  // [lane-2] ensure-live
  // [lane-3] ensure-live
  // [lane-4] ensure-live
  // [lane-5] ensure-live
  await spawnChild(
    input.sessionId,
    path,
    buildClaudeSpawnArgs(launch),
    input.cwd,
    { provider: "claude", id: input.providerAccountId ?? "default" },
    "claude",
  );

  liveByThread.set(input.sessionId, live);
  resumeByThread.set(input.sessionId, {
    sessionId: claudeSessionId,
    cwd: input.cwd,
    providerAccountId: input.providerAccountId,
    ...(canResume ? {} : { prompted: false }),
  });

  try {
    await writeJson(
      input.sessionId,
      buildControlRequest(nextControlId(live), { subtype: "initialize" }),
    );
    await waitForInit(live, initTimeoutMs);
    live.onEvent({
      type: "session.providerBound",
      providerSessionId: live.claudeSessionId,
    });
    live.onEvent({ type: "session.started" });
    return live;
  } catch (error) {
    await stopClaudeSession(input.sessionId);
    throw error;
  }
}

async function runTurn(live: Live, input: SendTurnInput): Promise<void> {
  const effort = input.modelSettings?.effort;
  const message = buildClaudeUserMessage({
    text: input.text,
    attachments: input.attachments,
    effort,
  });
  const content = (message.message as { content: unknown[] }).content;
  if (content.length === 0) return;

  live.emittedAssistant = "";
  live.emittedReasoning = "";
  live.pendingAssistantBoundary = false;
  live.toolsByIndex.clear();
  live.toolsById.clear();
  live.agentTasks.clear();
  live.backgroundTasks.clear();
  live.backgroundRows.clear();
  clearAwaitingResume(live);
  live.backgroundKey = "";
  live.taskNotes = [];
  live.turnResultSeen = false;

  const turnPromise = new Promise<void>((resolve, reject) => {
    live.turnDone = resolve;
    live.turnFailed = reject;
  });
  live.activeTurn = true;
  settlePendingTurn(live);

  // Where this prompt joins the conversation, so it can be taken back later.
  // A compaction is not a prompt of the user's: there is no message in the
  // transcript for its boundary to land on.
  const boundary = live.manualCompaction
    ? undefined
    : promptBoundary(input.sessionId, live);
  if (boundary)
    live.onEvent({ type: "turn.started", providerTurnId: boundary });

  try {
    await writeJson(input.sessionId, message);
    // The prompt now follows the cut in Claude's own file.
    if (live.cutPending) {
      live.cutPending = false;
      rewindByThread.delete(input.sessionId);
    }
    notePromptSent(input.sessionId, live);
    input.onAccepted?.();
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

function handleLine(sessionId: string, live: Live, line: string): void {
  const rec = parseJsonLine(line);
  if (!rec) return;

  const type = stringField(rec, "type");
  if (type === "keep_alive") return;

  const cancelId = parseControlCancelId(rec);
  if (cancelId) {
    for (const [uiId, pending] of live.approvals) {
      if (pending.requestId === cancelId) {
        pending.resolve("cancelled");
        live.approvals.delete(uiId);
      }
    }
    for (const [uiId, pending] of live.questions) {
      if (pending.requestId === cancelId) {
        pending.resolve("cancelled");
        live.questions.delete(uiId);
      }
    }
    return;
  }

  const control = parseControlRequest(rec);
  if (control) {
    const turn = live.turnDone;
    void handleControlRequest(sessionId, live, control).catch(
      (error: unknown) => {
        if (live.muteUpdates || live.turnDone !== turn) return;
        const failure =
          error instanceof Error ? error : new Error(String(error));
        if (live.turnFailed) {
          live.turnFailed(failure);
        } else {
          live.onEvent({ type: "session.error", message: failure.message });
        }
      },
    );
    return;
  }

  // Before the mute: what Claude writes while a stop settles is still part of
  // its conversation, and the next prompt follows it.
  noteChainEntry(sessionId, live, rec);
  noteCompaction(sessionId, rec);

  if (live.muteUpdates) return;

  const sessionIdFromLine = sessionIdFromMessage(rec);
  if (sessionIdFromLine && sessionIdFromLine !== live.claudeSessionId) {
    live.claudeSessionId = sessionIdFromLine;
    // A different conversation starts with its own task ids.
    live.claudeTasks = new Map();
    tasksByThread.set(sessionId, {
      providerSessionId: sessionIdFromLine,
      tasks: live.claudeTasks,
    });
    resumeByThread.set(sessionId, {
      sessionId: sessionIdFromLine,
      cwd: live.cwd,
      providerAccountId: live.providerAccountId,
    });
    live.onEvent({
      type: "session.providerBound",
      providerSessionId: sessionIdFromLine,
    });
  }

  if (
    type === "system" &&
    (stringField(rec, "subtype") === "init" ||
      stringField(rec, "subtype") === "initialized")
  ) {
    markInitialized(live);
    if (stringField(rec, "subtype") === "init") noteClaudeTurnStarted(live);
    // Includes claude.ai connectors and plugin servers, which no config file
    // the app reads names. The connector switches list them from this.
    const servers = initMcpServers(rec);
    if (servers) {
      noteReportedMcpServers(sessionId, servers);
    }
  }

  if (type === "control_response") {
    markInitialized(live);
    return;
  }

  if (live.manualCompaction && type !== "system" && type !== "result") {
    return;
  }

  if (handleAgentLifecycle(live, rec)) return;
  if (type === "tool_progress") {
    handleToolProgress(live, rec);
    return;
  }
  if (type === "stream_event") {
    if (!isSubagentMessage(rec)) noteClaudeTurnStarted(live);
    handleStreamEvent(live, rec);
    return;
  }
  if (type === "assistant") {
    if (!isSubagentMessage(rec)) noteClaudeTurnStarted(live);
    handleAssistant(live, rec);
    return;
  }
  if (type === "user") {
    handleUser(sessionId, live, rec);
    return;
  }
  if (type === "result") {
    handleResult(live, rec);
    return;
  }
  if (type === "rate_limit_event") {
    live.usageLimit = usageLimitFromRateLimitEvent(rec);
    return;
  }
  if (type === "system") {
    const text = statusTextFromSystem(rec);
    if (text) {
      if ((stringField(rec, "subtype") ?? "").startsWith("compact")) {
        live.compactionConfirmed = true;
      }
      live.onEvent({ type: "status", text });
    }
  }
}

function handleStreamEvent(live: Live, rec: Record<string, unknown>): void {
  const subagent = isSubagentMessage(rec);
  const delta = streamDeltaFromEvent(rec);
  if (delta) {
    if (subagent) return;
    if (delta.kind === "assistant") {
      closePendingAssistantMessage(live);
      live.emittedAssistant = joinStreamText(live.emittedAssistant, delta.text);
      live.onEvent({ type: "message.delta", text: delta.text });
    } else {
      live.emittedReasoning = joinStreamText(live.emittedReasoning, delta.text);
      live.onEvent({ type: "reasoning.delta", text: delta.text });
    }
    return;
  }

  const started = toolStartFromEvent(rec);
  if (started) {
    if (subagent) {
      noteSubagentTool(live, rec, started.id, started.name, started.input);
      return;
    }
    const tool: InFlightTool = {
      id: started.id,
      name: started.name,
      input: started.input,
      partialJson: "",
      title: toolTitle(started.name, started.input),
    };
    if (started.index >= 0) live.toolsByIndex.set(started.index, tool);
    live.toolsById.set(started.id, tool);
    live.onEvent({
      type: "tool.started",
      callId: tool.id,
      title: tool.title,
      kind: toolKindFromName(tool.name),
      ...(isAgentToolName(tool.name) && stringField(tool.input, "model")
        ? { agentModel: stringField(tool.input, "model") }
        : {}),
      status: isAgentToolName(tool.name) ? "in_progress" : "pending",
      ...bashCommandField(tool.name, tool.input),
      preview: previewFromTool(tool.name, tool.input),
    });
    emitTaskListIfNeeded(live, tool.name, tool.input);
    return;
  }

  const jsonDelta = inputJsonDeltaFromEvent(rec);
  if (jsonDelta) {
    if (subagent) return;
    const tool = live.toolsByIndex.get(jsonDelta.index);
    if (!tool) return;
    tool.partialJson += jsonDelta.partial;
    const parsed = tryParseJsonRecord(tool.partialJson);
    if (!parsed) return;
    tool.input = parsed;
    tool.title = toolTitle(tool.name, parsed);
    live.onEvent({
      type: "tool.updated",
      callId: tool.id,
      title: tool.title,
      kind: toolKindFromName(tool.name),
      ...(isAgentToolName(tool.name) && stringField(tool.input, "model")
        ? { agentModel: stringField(tool.input, "model") }
        : {}),
      status: "pending",
      detail: summarizeToolRequest(tool.name, parsed),
      ...bashCommandField(tool.name, parsed),
      preview: previewFromTool(tool.name, parsed),
    });
    emitTaskListIfNeeded(live, tool.name, parsed);
    return;
  }
}

function handleAssistant(live: Live, rec: Record<string, unknown>): void {
  if (isSubagentMessage(rec)) {
    noteSubagentNarration(live, rec);
    for (const use of assistantToolUses(rec)) {
      noteSubagentTool(live, rec, use.id, use.name, use.input);
    }
    return;
  }

  const used = contextUsedFromAssistant(rec);
  if (used !== undefined) live.onEvent({ type: "context", used });

  const snapshot = assistantTextBlocks(rec).join("");
  if (snapshot) closePendingAssistantMessage(live);
  const extra = snapshotRemainder(live.emittedAssistant, snapshot);
  if (extra) {
    live.emittedAssistant = joinStreamText(live.emittedAssistant, extra);
    live.onEvent({ type: "message.delta", text: extra });
  }

  for (const use of assistantToolUses(rec)) {
    const streamed = live.toolsById.get(use.id);
    if (streamed) {
      // content_block_start often has an empty input. The input JSON delta may
      // never form a parseable object before the complete assistant snapshot.
      // Reconcile that snapshot instead of leaving the tool labelled "Shell".
      if (JSON.stringify(streamed.input) !== JSON.stringify(use.input)) {
        streamed.input = use.input;
        streamed.title = toolTitle(use.name, use.input);
        live.onEvent({
          type: "tool.updated",
          callId: streamed.id,
          title: streamed.title,
          kind: toolKindFromName(streamed.name),
          ...(isAgentToolName(streamed.name) && stringField(use.input, "model")
            ? { agentModel: stringField(use.input, "model") }
            : {}),
          status: isAgentToolName(streamed.name) ? "in_progress" : "pending",
          preview: previewFromTool(streamed.name, use.input),
        });
        emitTaskListIfNeeded(live, streamed.name, use.input);
      }
      if (use.name === "ExitPlanMode") {
        const plan = extractExitPlanModePlan(use.input);
        if (plan) live.onEvent({ type: "plan", text: plan });
      }
      continue;
    }
    const tool: InFlightTool = {
      id: use.id,
      name: use.name,
      input: use.input,
      partialJson: "",
      title: toolTitle(use.name, use.input),
    };
    live.toolsById.set(use.id, tool);
    live.onEvent({
      type: "tool.started",
      callId: tool.id,
      title: tool.title,
      kind: toolKindFromName(tool.name),
      ...(isAgentToolName(tool.name) && stringField(tool.input, "model")
        ? { agentModel: stringField(tool.input, "model") }
        : {}),
      status: isAgentToolName(tool.name) ? "in_progress" : "pending",
      ...bashCommandField(tool.name, tool.input),
      preview: previewFromTool(tool.name, tool.input),
    });
    if (use.name === "ExitPlanMode") {
      const plan = extractExitPlanModePlan(use.input);
      if (plan) live.onEvent({ type: "plan", text: plan });
    }
    emitTaskListIfNeeded(live, tool.name, tool.input);
  }

  // Each assistant record is one Claude message. Wait until the next message
  // begins to close its UI block, so a backgrounded turn stays visibly live.
  live.pendingAssistantBoundary = !!(snapshot || live.emittedAssistant);
  live.emittedAssistant = "";
  live.emittedReasoning = "";
}

function closePendingAssistantMessage(live: Live): void {
  if (!live.pendingAssistantBoundary) return;
  live.pendingAssistantBoundary = false;
  live.onEvent({ type: "message.completed" });
}

function handleUser(
  sessionId: string,
  live: Live,
  rec: Record<string, unknown>,
): void {
  if (isSubagentMessage(rec)) {
    noteSubagentResults(sessionId, live, rec);
    return;
  }
  for (const result of toolResultsFromUserMessage(rec)) {
    const tool = live.toolsById.get(result.toolUseId);
    if (!tool) continue;
    if (isAgentToolName(tool.name) && isBackgroundedAgentTool(live, tool.id)) {
      continue;
    }
    live.onEvent({
      type: "tool.updated",
      callId: tool.id,
      title: tool.title,
      kind: toolKindFromName(tool.name),
      status: result.isError ? "failed" : "completed",
      detail: result.text || undefined,
      preview: previewFromTool(tool.name, tool.input, result.text),
    });
    keepResultImages(sessionId, live, tool.id, result);
    if (
      !result.isError &&
      applyClaudeTaskTool(live.claudeTasks, tool.name, tool.input, result.text)
    ) {
      live.onEvent({
        type: "tasks.updated",
        key: CLAUDE_TASKS_KEY,
        // The map is the source of truth, so a TaskUpdate subject is a rename.
        authoritative: true,
        providerSessionId: live.claudeSessionId,
        items: [...live.claudeTasks.values()],
      });
    }
    // What a subagent hands back is the last thing it said, so it closes out
    // that agent's own trail rather than sitting on the parent row as detail.
    if (isAgentToolName(tool.name) && result.text.trim() && !result.isError) {
      live.onEvent({
        type: "agent.step",
        callId: tool.id,
        stepId: `${tool.id}:report`,
        kind: "message",
        text: result.text,
      });
    }
    if (isAgentToolName(tool.name)) settleInlineAgentTask(live, tool.id);
  }
}

/**
 * A subagent that was never backgrounded reports back on the parent's own tool
 * result, and Claude sends no task record for one that ended inline. Without
 * this its task would keep the turn open for good: the reply reads as finished
 * while the composer and the plan's Build button stay disabled until a restart.
 */
function settleInlineAgentTask(live: Live, toolUseId: string): void {
  let settled = false;
  for (const [taskId, task] of [...live.agentTasks]) {
    if (task.toolUseId !== toolUseId || task.backgrounded) continue;
    live.agentTasks.delete(taskId);
    live.backgroundTasks.delete(taskId);
    settled = true;
  }
  if (!settled) return;
  maybeFinishTurn(live);
  syncBackgroundWait(live);
}

function handleResult(live: Live, rec: Record<string, unknown>): void {
  if (isSubagentMessage(rec)) return;
  // A /compact result reports the summarizer call's usage, not the rebuilt
  // conversation level. The next real turn will provide the fresh reading.
  if (!live.manualCompaction) {
    const context = contextFromResult(rec);
    if (context) live.onEvent({ type: "context", ...context });
  }
  const metrics = turnMetricsFromResult(rec);
  if (metrics) live.onEvent({ type: "turn.metrics", ...metrics });

  const result = turnStatusFromResult(rec);
  if (result.status === "failed" && result.error && !live.cancelled) {
    live.onEvent({ type: "session.error", message: result.error });
  }
  // A refused window can still fall back to another model, so only a turn
  // that ended in error was stopped by it.
  const turnErrored = rec.is_error === true || result.status === "failed";
  const usageLimit = live.usageLimit ?? (isUsageLimitResult(rec) ? {} : null);
  live.usageLimit = null;
  if (usageLimit && turnErrored && !live.cancelled) {
    live.onEvent({ type: "usage.limited", ...usageLimit });
  }
  live.turnResultSeen = true;
  maybeFinishTurn(live);
  showBackgroundRows(live);
  syncBackgroundWait(live);
}

async function handleControlRequest(
  sessionId: string,
  live: Live,
  control: ClaudeControlRequest,
): Promise<void> {
  if (control.subtype !== "can_use_tool" && control.subtype !== "permission") {
    await writeJson(sessionId, buildControlResponse(control.requestId, {}));
    return;
  }

  const toolName = control.toolName ?? "tool";
  const input = control.input ?? {};

  if (live.cancelled || live.muteUpdates) {
    await writeJson(
      sessionId,
      buildControlResponse(
        control.requestId,
        toClaudePermissionResult("deny", input),
      ),
    ).catch(() => undefined);
    return;
  }

  if (toolName === "AskUserQuestion") {
    const questions = questionsFromUnknown(input);
    const uiId = live.nextApprovalUiId++;
    const pending = waitQuestion(live, uiId, control.requestId, {
      type: "question.asked",
      requestId: uiId,
      title:
        questionPromptTitle(questions) || extractAskUserQuestionTitle(input),
      questions,
      callId: control.toolUseId,
    });
    showNextQuestion(live);
    const outcome = await pending;
    const decision =
      outcome === "cancelled"
        ? "cancelled"
        : outcome.kind === "answered"
          ? "answered"
          : "skipped";
    live.onEvent({ type: "question.resolved", requestId: uiId, decision });
    showNextQuestion(live);
    if (outcome === "cancelled") return;
    const response =
      outcome.kind === "answered"
        ? {
            behavior: "allow",
            updatedInput: askUserQuestionAllowInput(input, outcome),
          }
        : {
            behavior: "deny",
            message: "User cancelled tool execution.",
          };
    await writeJson(
      sessionId,
      buildControlResponse(control.requestId, response),
    );
    return;
  }

  if (toolName === "ExitPlanMode") {
    const plan = extractExitPlanModePlan(input);
    if (plan) live.onEvent({ type: "plan", text: plan });
    await writeJson(
      sessionId,
      buildControlResponse(control.requestId, {
        behavior: "deny",
        message:
          "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
      }),
    );
    return;
  }

  applyKnownToolInput(live, toolName, input, control.toolUseId);

  // A tool blocked for this chat is refused in every mode, plan turns
  // included, and without a card. The reason goes back as the tool's error.
  if (live.toolRules.never.has(toolName)) {
    await writeJson(
      sessionId,
      buildControlResponse(control.requestId, {
        behavior: "deny",
        message: claudeBlockedToolMessage(toolName),
      }),
    );
    return;
  }

  if (live.planning) {
    const kind = toolKindFromName(toolName);
    const decision = kind === "read" || kind === "search" ? "allow" : "deny";
    await writeJson(
      sessionId,
      buildControlResponse(
        control.requestId,
        toClaudePermissionResult(decision, input),
      ),
    );
    return;
  }

  // A web fetch, or a browser tool that opens a site or runs code: the
  // site's rule decides, for this chat or this project. A Never rule for any
  // host the call names refuses it. With no rule, the card names the host,
  // even when the tool itself is always allowed: that rule does not cover new
  // sites. A call no rule may answer (no website named, several, or code)
  // always shows the card. Full access never asks, as for any tool.
  const site = siteApprovalRequest_l5(toolName, input);
  if (site) {
    const blocked = site.hosts.find(
      (host) => siteRule_l5(sessionId, live.cwd, host) === "never",
    );
    if (blocked) {
      await writeJson(
        sessionId,
        buildControlResponse(control.requestId, {
          behavior: "deny",
          message: site.fetch
            ? blockedFetchMessage_l5(blocked)
            : blockedSiteMessage_l5(blocked),
        }),
      );
      return;
    }
    if (
      site.ruleable &&
      siteRule_l5(sessionId, live.cwd, site.host) === "always"
    ) {
      await writeJson(
        sessionId,
        buildControlResponse(
          control.requestId,
          toClaudePermissionResult("allow", input),
        ),
      );
      return;
    }
  }

  // "Always allow" comes after the plan branch on purpose: a plan turn stays
  // read-only whatever the chat's rules say. For a tool that writes a file,
  // it answers only when the file sits inside the chat's folders; anything
  // else goes on to the mode and the card.
  // "Allow for this chat" on a command card keeps a rule for that command's
  // prefix only (Claude Code's own "don't ask again for"). Before it answers,
  // the project is checked for what the rule's words would run that the user
  // never saw: a command the repository's git config names, for one.
  const commandRuleKey_s6 =
    !site &&
    toolName === COMMAND_RULE_TOOL &&
    !live.toolRules.always.has(toolName)
      ? matchingCommandRule(live.toolRules.always, input.command)
      : null;
  const commandGate_s6 = commandRuleKey_s6
    ? await commandRuleGate(commandRuleKey_s6, live.cwd, undefined, sessionId)
    : null;
  if (
    !site &&
    (live.toolRules.always.has(toolName) || commandGate_s6?.allow === true) &&
    (await claudeRuleHeldToFolders_l5(live, toolName, input))
  ) {
    await writeJson(
      sessionId,
      buildControlResponse(
        control.requestId,
        toClaudePermissionResult("allow", input),
      ),
    );
    return;
  }

  if (live.runtimeMode === "full-access") {
    await writeJson(
      sessionId,
      buildControlResponse(
        control.requestId,
        toClaudePermissionResult("allow", input),
      ),
    );
    return;
  }

  const uiId = live.nextApprovalUiId++;
  const pending = waitApproval(live, uiId, control.requestId, toolName, input);
  // Only a request that names its tool can be remembered by a rule.
  const tool = approvalTool(control.toolName);
  // A rule whose script changed since it was allowed is named on the card,
  // so allowing it again keeps the script as it is now.
  // A package script prefix waits for package.json; other cards do not wait.
  const heldRule =
    commandGate_s6?.allow === false &&
    commandGate_s6.reason === "script-changed" &&
    commandRuleKey_s6
      ? { ...approvalTool(commandRuleKey_s6)!, changed: true }
      : heldChatRule_s6(
          claudeCommandChatRule(toolName, input, control.permissionSuggestions),
          input.command,
          live.cwd,
        );
  const chatRule: ApprovalTool | undefined =
    heldRule instanceof Promise ? await heldRule : heldRule;
  // Read without holding the card back; an answer waits for it (R3).
  const scriptPrint = chatRule
    ? chatRuleScriptPrint_s6(chatRule.key, live.cwd)
    : undefined;
  if (scriptPrint) {
    const entry = live.approvals.get(uiId);
    if (entry) entry.scriptPrint = scriptPrint;
  }
  live.onEvent({
    type: "approval.requested",
    requestId: uiId,
    title: toolTitle(toolName, input),
    kind: toolKindFromName(toolName),
    callId: control.toolUseId,
    preview: previewFromTool(toolName, input),
    ...(tool ? { tool } : {}),
    ...(chatRule ? { chatRule } : {}),
    ...(site
      ? { site: { ...site, chatKey: sessionId, projectKey: live.cwd } }
      : {}),
  });
  const decision = await pending;
  live.onEvent({ type: "approval.resolved", requestId: uiId, decision });
  if (decision === "cancelled") return;
  await writeJson(
    sessionId,
    buildControlResponse(
      control.requestId,
      // Declined because the user blocked the tool while the card was up:
      // say so, the same as a call the rule refuses outright.
      decision === "deny" && live.toolRules.never.has(toolName)
        ? { behavior: "deny", message: claudeBlockedToolMessage(toolName) }
        : toClaudePermissionResult(decision, input),
    ),
  );
}

/**
 * The rule "Allow for this chat" keeps for a Bash card: Claude Code's own
 * suggestion (`npm test *`), or one derived from the command. A command that
 * chains, pipes or redirects gets an exact rule for that text only, whatever
 * Claude Code suggested for one of its parts.
 */
function claudeCommandChatRule(
  toolName: string,
  input: Record<string, unknown>,
  suggestions: unknown,
): ApprovalTool | undefined {
  if (toolName !== COMMAND_RULE_TOOL) return undefined;
  const command = input.command;
  const rule =
    typeof command === "string" && isCompoundCommand(command)
      ? deriveCommandRule(command)
      : commandRuleForRequest(command, suggestions);
  return rule ? approvalTool(commandRuleKey(rule)) : undefined;
}

function applyKnownToolInput(
  live: Live,
  toolName: string,
  input: Record<string, unknown>,
  callId?: string,
): void {
  if (!callId || Object.keys(input).length === 0) return;
  const existing = live.toolsById.get(callId);
  if (existing) {
    existing.input = input;
    existing.title = toolTitle(toolName, input);
  }
  live.onEvent({
    type: "tool.updated",
    callId,
    title: toolTitle(toolName, input),
    kind: toolKindFromName(toolName),
    status: "pending",
    preview: previewFromTool(toolName, input),
  });
}

function waitApproval(
  live: Live,
  uiId: number,
  requestId: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<ApprovalOutcome> {
  return new Promise<ApprovalOutcome>((resolve) => {
    live.approvals.set(uiId, { requestId, toolName, input, resolve });
  }).finally(() => {
    live.approvals.delete(uiId);
  });
}

function waitQuestion(
  live: Live,
  uiId: number,
  requestId: string,
  event: Extract<HarnessEvent, { type: "question.asked" }>,
): Promise<UserQuestionReply | "cancelled"> {
  return new Promise<UserQuestionReply | "cancelled">((resolve) => {
    live.questions.set(uiId, { requestId, event, resolve });
  }).finally(() => {
    live.questions.delete(uiId);
  });
}

function showNextQuestion(live: Live): void {
  if (live.muteUpdates || live.cancelled) return;
  if (
    live.visibleQuestionId !== null &&
    live.questions.has(live.visibleQuestionId)
  )
    return;
  const next = live.questions.entries().next().value;
  live.visibleQuestionId = next?.[0] ?? null;
  if (next) live.onEvent(next[1].event);
}

function emitTaskListIfNeeded(
  live: Live,
  toolName: string,
  input: Record<string, unknown>,
): void {
  if (!isTodoTool(toolName)) return;
  const items = taskListFromTodos(input);
  if (items) live.onEvent({ type: "tasks.updated", items });
}

function handleAgentLifecycle(
  live: Live,
  rec: Record<string, unknown>,
): boolean {
  const started = parseTaskStarted(rec);
  if (started) {
    if (started.ambient) return true;
    live.backgroundTasks.set(started.taskId, {
      description: started.description,
      toolUseId: started.toolUseId,
      taskType: started.taskType,
      startedAt:
        live.backgroundTasks.get(started.taskId)?.startedAt ?? Date.now(),
    });
    syncBackgroundWait(live);
    if (!isAgentTaskType(started.taskType)) return true;
    live.agentTasks.set(started.taskId, {
      taskId: started.taskId,
      toolUseId: started.toolUseId,
      description: started.description,
      backgrounded: started.backgrounded,
    });
    upsertAgentTool(
      live,
      started.toolUseId,
      started.description,
      "in_progress",
    );
    return true;
  }

  const progress = parseTaskProgress(rec);
  if (progress) {
    const task = live.agentTasks.get(progress.taskId);
    const title = progress.description || task?.description || "Subagent";
    const detail =
      progress.summary ||
      progress.lastToolName ||
      (progress.subagentType
        ? `${progress.subagentType.replace(/[_-]+/g, " ")} subagent`
        : undefined);
    upsertAgentTool(
      live,
      progress.toolUseId ?? task?.toolUseId,
      title,
      "in_progress",
      detail,
    );
    return true;
  }

  const updated = parseTaskUpdated(rec);
  if (updated) {
    const task = live.agentTasks.get(updated.taskId);
    if (task && updated.backgrounded !== undefined) {
      task.backgrounded = updated.backgrounded;
    }
    if (task && updated.description) task.description = updated.description;
    const background = live.backgroundTasks.get(updated.taskId);
    if (background && updated.description) {
      background.description = updated.description;
    }
    if (isTerminalAgentTaskStatus(updated.status)) {
      settleBackgroundRow(
        live,
        updated.taskId,
        updated.status ?? "completed",
        updated.error,
      );
      finishBackgroundTask(live, updated.taskId);
      completeAgentTask(
        live,
        updated.taskId,
        updated.status === "completed" ? "completed" : "failed",
        updated.error,
      );
    }
    return true;
  }

  const notice = parseTaskNotification(rec);
  if (notice) {
    if (!notice.ambient) {
      noteTaskNotification(live, notice);
      finishBackgroundTask(live, notice.taskId);
      completeAgentTask(
        live,
        notice.taskId,
        notice.status === "completed" ? "completed" : "failed",
        notice.summary || undefined,
      );
    }
    return true;
  }

  const allTasks = parseBackgroundTasks(rec);
  if (!allTasks) return false;
  const next = new Set(allTasks.map((task) => task.taskId));
  for (const id of [...live.backgroundTasks.keys()]) {
    if (next.has(id)) continue;
    settleBackgroundRow(live, id, "completed");
    finishBackgroundTask(live, id);
  }
  for (const row of allTasks) {
    if (!live.backgroundTasks.has(row.taskId)) {
      live.backgroundTasks.set(row.taskId, {
        description: row.description,
        taskType: row.taskType,
        startedAt: Date.now(),
      });
    }
  }
  const liveTasks = allTasks.filter((task) => isAgentTaskType(task.taskType));
  for (const id of [...live.agentTasks.keys()]) {
    if (!next.has(id)) completeAgentTask(live, id, "completed");
  }
  for (const row of liveTasks) {
    if (live.agentTasks.has(row.taskId)) continue;
    // The list carries no tool_use_id and often lands before task_started, so
    // find the Agent call that spawned it rather than opening a second row.
    const toolUseId = unclaimedAgentCall(live, row.description);
    live.agentTasks.set(row.taskId, {
      taskId: row.taskId,
      toolUseId,
      description: row.description,
      backgrounded: true,
    });
    upsertAgentTool(live, toolUseId, row.description, "in_progress");
  }
  maybeFinishTurn(live);
  syncBackgroundWait(live);
  return true;
}

function handleToolProgress(live: Live, rec: Record<string, unknown>): void {
  const progress = parseToolProgress(rec);
  if (!progress) return;
  const tool =
    live.toolsById.get(progress.toolUseId) ??
    (progress.parentToolUseId
      ? live.toolsById.get(progress.parentToolUseId)
      : undefined);
  if (!tool || !isAgentToolName(tool.name)) return;
  live.onEvent({
    type: "tool.updated",
    callId: tool.id,
    title: tool.title,
    kind: "agent",
    status: "in_progress",
  });
  // Progress names the call in flight. That is a step in the run, not the
  // result of it, so it goes to the panel rather than onto the Agent row.
  if (progress.toolName) {
    live.onEvent({
      type: "agent.step",
      callId: tool.id,
      stepId: progress.toolUseId,
      kind: "tool",
      text: progress.toolName,
      status: "in_progress",
      ...(progress.subagentType ? { agentType: progress.subagentType } : {}),
    });
  }
}

/**
 * The Agent call a subagent message belongs to, or nothing when the message
 * came from somewhere the parent transcript has no row for.
 */
function subagentParent(
  live: Live,
  rec: Record<string, unknown>,
): InFlightTool | undefined {
  const parentId = stringField(rec, "parent_tool_use_id");
  if (!parentId) return undefined;
  const parent = live.toolsById.get(parentId);
  if (!parent || !isAgentToolName(parent.name)) return undefined;
  return parent;
}

/**
 * A call a subagent made, mirrored onto the Agent row that spawned it. The
 * parent keeps its own "still running" status; the step is what the panel
 * under that row reads back.
 */
function noteSubagentTool(
  live: Live,
  rec: Record<string, unknown>,
  id: string,
  name: string,
  input: Record<string, unknown>,
): void {
  const parent = subagentParent(live, rec);
  if (!parent) return;
  const title = toolTitle(name, input);
  // No detail: the Agent row's detail is the report the run hands back, and
  // writing the call of the moment there would leave whatever the subagent
  // happened to do last standing in as its result.
  live.onEvent({
    type: "tool.updated",
    callId: parent.id,
    title: parent.title,
    kind: "agent",
    status: "in_progress",
  });
  if (!id) return;
  const preview = previewFromTool(name, input);
  live.onEvent({
    type: "agent.step",
    callId: parent.id,
    stepId: id,
    kind: "tool",
    text: title,
    toolKind: toolKindFromName(name),
    status: "in_progress",
    ...(preview ? { preview } : {}),
  });
}

/**
 * What a subagent said and thought on its way through the work. Its prose
 * never joins the parent transcript — that would read as the main agent
 * talking — but it is the most legible thing in the panel for its own row.
 */
function noteSubagentNarration(live: Live, rec: Record<string, unknown>): void {
  const parent = subagentParent(live, rec);
  if (!parent) return;
  const model = stringField(asRecord(rec.message), "model");
  if (model)
    live.onEvent({
      type: "tool.updated",
      callId: parent.id,
      kind: "agent",
      agentModel: model,
    });
  const messageId = assistantMessageId(rec) ?? crypto.randomUUID();
  const thinking = assistantThinkingBlocks(rec).join("").trim();
  if (thinking) {
    live.onEvent({
      type: "agent.step",
      callId: parent.id,
      stepId: `${messageId}:thinking`,
      kind: "reasoning",
      text: thinking,
    });
  }
  const text = assistantTextBlocks(rec).join("").trim();
  if (text) {
    live.onEvent({
      type: "agent.step",
      callId: parent.id,
      stepId: `${messageId}:text`,
      kind: "message",
      text,
    });
  }
}

/** Settles the subagent's own tool rows once their results come back. */
function noteSubagentResults(
  sessionId: string,
  live: Live,
  rec: Record<string, unknown>,
): void {
  const parent = subagentParent(live, rec);
  if (!parent) return;
  for (const result of toolResultsFromUserMessage(rec)) {
    live.onEvent({
      type: "agent.step",
      callId: parent.id,
      stepId: result.toolUseId,
      kind: "tool",
      text: "",
      status: result.isError ? "failed" : "completed",
      ...(result.isError && result.text ? { detail: result.text } : {}),
    });
    // A subagent's screenshots go on its own row in the parent transcript.
    keepResultImages(sessionId, live, parent.id, result);
  }
}

/**
 * Keeps the images a tool result carried so the transcript can show them.
 * Claude has already been sent the result; this only saves a copy and tells
 * the transcript where it is once the files are written.
 */
function keepResultImages(
  sessionId: string,
  live: Live,
  callId: string,
  result: { toolUseId: string; images?: ToolResultImage[] },
): void {
  if (!result.images?.length) return;
  void keepToolResultImages({
    sessionId,
    callId,
    sourceId: result.toolUseId,
    images: result.images,
    emit: (event) => live.onEvent(event),
    // Not once the session has been stopped or handed to a new process.
    wanted: () => liveByThread.get(sessionId) === live,
  });
}

function isBackgroundedAgentTool(live: Live, toolUseId: string): boolean {
  for (const task of live.agentTasks.values()) {
    if (task.toolUseId === toolUseId && task.backgrounded) return true;
  }
  return false;
}

/** The latest Agent call with this description that no task has claimed yet. */
function unclaimedAgentCall(
  live: Live,
  description: string,
): string | undefined {
  const claimed = new Set(
    [...live.agentTasks.values()].map((task) => task.toolUseId),
  );
  let match: string | undefined;
  for (const tool of live.toolsById.values()) {
    if (!isAgentToolName(tool.name) || claimed.has(tool.id)) continue;
    if (stringField(tool.input, "description") === description) match = tool.id;
  }
  return match;
}

function upsertAgentTool(
  live: Live,
  callId: string | undefined,
  title: string,
  status: string,
  detail?: string,
): void {
  const id = callId ?? `agent:${title}`;
  const existing = live.toolsById.get(id);
  if (!existing) {
    live.toolsById.set(id, {
      id,
      name: "Agent",
      input: {},
      partialJson: "",
      title,
    });
    live.onEvent({
      type: "tool.started",
      callId: id,
      title,
      kind: "agent",
      status,
    });
    if (
      status !== "in_progress" &&
      status !== "pending" &&
      status !== "running"
    ) {
      live.onEvent({
        type: "tool.updated",
        callId: id,
        title,
        kind: "agent",
        status,
        ...(detail ? { detail } : {}),
      });
    }
    return;
  }
  if (title) existing.title = title;
  live.onEvent({
    type: "tool.updated",
    callId: id,
    title: existing.title,
    kind: "agent",
    status,
    ...(detail ? { detail } : {}),
  });
}

function completeAgentTask(
  live: Live,
  taskId: string,
  status: string,
  detail?: string,
): void {
  const task = live.agentTasks.get(taskId);
  live.agentTasks.delete(taskId);
  if (task) {
    upsertAgentTool(
      live,
      task.toolUseId,
      task.description,
      status,
      detail ?? (status === "failed" ? "Subagent failed." : undefined),
    );
  }
  maybeFinishTurn(live);
}

/**
 * A task is done. If Claude had already yielded, the notification about it
 * starts a follow-up turn, so hold the MonoCode turn open for that too rather
 * than settling in the gap between the two.
 */
function finishBackgroundTask(live: Live, taskId: string): void {
  if (!live.backgroundTasks.delete(taskId)) return;
  if (live.turnResultSeen && live.activeTurn && !live.awaitingResume) {
    live.awaitingResume = setTimeout(() => {
      live.awaitingResume = null;
      maybeFinishTurn(live);
      syncBackgroundWait(live);
    }, RESUME_GRACE_MS);
  }
  maybeFinishTurn(live);
  syncBackgroundWait(live);
}

/**
 * Claude began another turn inside this MonoCode turn: woken by a finished
 * task, or by a follow-up written in while it waited. Its own result, not the
 * earlier one, decides when the MonoCode turn ends.
 */
function noteClaudeTurnStarted(live: Live): void {
  if (!live.activeTurn || !live.turnResultSeen) return;
  live.turnResultSeen = false;
  // A new message, not more of the last one: its snapshot must not be
  // compared against what the earlier turn streamed.
  live.emittedAssistant = "";
  live.emittedReasoning = "";
  live.pendingAssistantBoundary = false;
  // Close the message Claude left off with, so the reply starts its own and
  // the fold puts the earlier one away, the same as prose between tool calls.
  // A background command's row already sits between the two; a subagent's
  // report is noted in the trail to do the same.
  live.onEvent({ type: "message.completed" });
  live.onEvent({ type: "reasoning.completed" });
  for (const text of live.taskNotes) live.onEvent({ type: "status", text });
  live.taskNotes = [];
  clearAwaitingResume(live);
  syncBackgroundWait(live);
}

/**
 * Claude yielded with commands still running. Each gets a live row under the
 * message it left off with, like any call in flight, until it finishes.
 * Subagents already have a row of their own.
 */
function showBackgroundRows(live: Live): void {
  if (!live.activeTurn || live.cancelled) return;
  for (const [taskId, task] of live.backgroundTasks) {
    if (live.backgroundRows.has(taskId) || live.agentTasks.has(taskId))
      continue;
    const source = task.toolUseId
      ? live.toolsById.get(task.toolUseId)
      : undefined;
    if (source && isAgentToolName(source.name)) continue;
    const callId = `background:${taskId}`;
    live.backgroundRows.set(taskId, callId);
    live.onEvent({
      type: "tool.started",
      callId,
      title: source ? toolTitle(source.name, source.input) : task.description,
      kind: source ? toolKindFromName(source.name) : "execute",
      status: "in_progress",
      background: true,
      ...(source
        ? { preview: previewFromTool(source.name, source.input) }
        : {}),
    });
  }
}

function settleBackgroundRow(
  live: Live,
  taskId: string,
  status: string,
  detail?: string,
): void {
  const callId = live.backgroundRows.get(taskId);
  if (!callId || live.muteUpdates) return;
  live.onEvent({
    type: "tool.updated",
    callId,
    status: status === "completed" ? "completed" : "failed",
    ...(detail ? { detail } : {}),
  });
}

/**
 * What Claude was told when a task finished. A command's row takes the
 * summary; a subagent's is kept for the trail until Claude picks back up.
 */
function noteTaskNotification(
  live: Live,
  notice: ClaudeAgentTaskNotification,
): void {
  if (!live.activeTurn) return;
  if (live.backgroundRows.has(notice.taskId)) {
    settleBackgroundRow(
      live,
      notice.taskId,
      notice.status,
      notice.summary || undefined,
    );
    return;
  }
  const tool = notice.toolUseId ? live.toolsById.get(notice.toolUseId) : null;
  const agent =
    (tool && isAgentToolName(tool.name)) || live.agentTasks.has(notice.taskId);
  if (!agent || !live.turnResultSeen) return;
  live.taskNotes.push(notice.summary || "Subagent finished.");
}

function clearAwaitingResume(live: Live): void {
  if (!live.awaitingResume) return;
  clearTimeout(live.awaitingResume);
  live.awaitingResume = null;
}

/**
 * Tells the UI what the turn is waiting on once Claude has yielded with work
 * still running, and clears it when Claude picks the thread back up.
 */
function syncBackgroundWait(live: Live): void {
  const waiting =
    live.activeTurn && live.turnResultSeen && !live.cancelled
      ? [...live.backgroundTasks.values()].map((task) => task.description)
      : [];
  // The Running section lists every task while it runs, not only once
  // Claude has yielded. A cancelled turn has asked all of them to stop.
  const items =
    live.activeTurn && !live.cancelled
      ? claudeBackgroundItems_l1(live.backgroundTasks)
      : [];
  const itemsKey = backgroundItemsKey_l1(items);
  if (itemsKey !== live.backgroundItemsKey_l1) {
    live.backgroundItemsKey_l1 = itemsKey;
    if (!live.muteUpdates) live.onEvent({ type: "background.items", items });
  }
  const key = waiting.join("\n");
  if (key === live.backgroundKey) return;
  live.backgroundKey = key;
  if (live.muteUpdates) return;
  live.onEvent({ type: "background.updated", tasks: waiting });
}

function maybeFinishTurn(live: Live): void {
  if (!live.turnResultSeen) return;
  if (live.agentTasks.size > 0 || live.backgroundTasks.size > 0) return;
  if (live.awaitingResume) return;
  if (!live.activeTurn && !live.turnDone) return;
  finishActiveTurn(live, [
    { type: "message.completed" },
    { type: "reasoning.completed" },
  ]);
}

function finishActiveTurn(live: Live, extraEvents: HarnessEvent[] = []): void {
  clearAwaitingResume(live);
  live.turnEndPending = false;
  live.activeTurn = false;
  for (const event of extraEvents) live.onEvent(event);
  const done = live.turnDone;
  const failed = live.turnFailed;
  live.turnDone = null;
  live.turnFailed = null;
  if (done) {
    done();
    return;
  }
  if (!failed) live.turnEndPending = true;
}

function settlePendingTurn(live: Live): void {
  if (!live.turnEndPending || !live.turnDone) return;
  finishActiveTurn(live);
}

function markInitialized(live: Live): void {
  if (live.initialized) return;
  live.initialized = true;
  live.initDone?.();
  live.initDone = null;
}

function waitForInit(live: Live, timeoutMs: number): Promise<void> {
  if (live.initialized) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      live.initDone = null;
      resolve();
    }, timeoutMs);
    live.initDone = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

function nextControlId(live: Live): string {
  live.nextControlId += 1;
  return `monocode_${live.nextControlId}`;
}

function writeJson(
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  return writeChild(sessionId, JSON.stringify(payload));
}

function settingsKeyFor(input: HarnessSessionInput): string {
  return `${input.providerAccountId ?? "default"}:${claudeSettingsKey({
    model: nativeModelId(input.model),
    effort: input.modelSettings?.effort,
    fast: input.modelSettings?.fast,
    thinking: input.modelSettings?.thinking,
    context: input.modelSettings?.context,
    runtimeMode: input.runtimeMode,
    hooks: loadClaudeHooks(),
    extraDirs: input.extraDirs,
    disabledMcpServers: input.disabledMcpServers,
    deniedTools: input.toolAccess?.never,
    disabledSkills: input.disabledSkills,
    disabledPlugins: input.disabledPlugins,
    gatewayConnectors: input.gatewayConnectors,
    // [lane-1] settings-key
    // [lane-2] settings-key
    // [lane-3] settings-key
    // [lane-4] settings-key
    toolLoading: loadClaudeToolLoading_l4(),
    // [lane-5] settings-key
  })}`;
}

/**
 * Records a message or tool result on the conversation's main chain. A
 * subagent's entries sit on a side chain, and stream events are not entries.
 */
function noteChainEntry(
  threadId: string,
  live: Live,
  rec: Record<string, unknown>,
): void {
  const type = stringField(rec, "type");
  if (type !== "assistant" && type !== "user") return;
  const parent = rec.parent_tool_use_id;
  if (typeof parent === "string" && parent.length > 0) return;
  const uuid = stringField(rec, "uuid");
  if (!uuid) return;
  lastEntryByThread.set(threadId, {
    providerSessionId: stringField(rec, "session_id") ?? live.claudeSessionId,
    uuid,
    claimed: false,
    // Streamed while a stop settles: the entries Claude writes for the stop
    // itself may still follow, unstreamed.
    ...(live.cancelled ? { stale: true } : {}),
  });
}

/**
 * After a compaction Claude's conversation starts over from a summary. The
 * entries seen before it are no longer places it can be cut back to.
 */
function noteCompaction(threadId: string, rec: Record<string, unknown>): void {
  if (stringField(rec, "type") !== "system") return;
  if (stringField(rec, "subtype") !== "compact_boundary") return;
  lastEntryByThread.delete(threadId);
}

/**
 * After a stopped turn, the place the next prompt joins the conversation is
 * read from Claude Code's transcript file, which has the entries it wrote on
 * the stop. When that cannot be read, the next prompt has no boundary and
 * cannot be taken back, rather than one that would replay the stopped call.
 */
async function refreshStaleEntry(threadId: string, live: Live): Promise<void> {
  const last = lastEntryByThread.get(threadId);
  if (!last?.stale) return;
  if (last.providerSessionId !== live.claudeSessionId) {
    lastEntryByThread.delete(threadId);
    return;
  }
  const uuid = await readClaudeLastEntry({
    cwd: live.cwd,
    sessionId: live.claudeSessionId,
    providerAccountId: live.providerAccountId,
  });
  // A newer entry streamed meanwhile is newer than the file read.
  if (lastEntryByThread.get(threadId) !== last) return;
  if (uuid) {
    lastEntryByThread.set(threadId, {
      providerSessionId: live.claudeSessionId,
      uuid,
      claimed: false,
    });
  } else {
    lastEntryByThread.delete(threadId);
  }
}

/** A prompt is now in Claude's conversation, after the last entry seen. */
function notePromptSent(threadId: string, live: Live): void {
  const resume = resumeByThread.get(threadId);
  if (resume?.prompted === false && resume.sessionId === live.claudeSessionId) {
    const { prompted: _prompted, ...rest } = resume;
    resumeByThread.set(threadId, rest);
  }
  const last = lastEntryByThread.get(threadId);
  if (last) last.claimed = true;
}

/**
 * The entry a prompt sent now will follow, or the first-turn mark for a new
 * conversation. Undefined when this run of the app has not seen where a
 * resumed conversation ends: its next prompt cannot be taken back.
 */
function promptBoundary(threadId: string, live: Live): string | undefined {
  const last = lastEntryByThread.get(threadId);
  const first = live.fresh;
  live.fresh = false;
  if (last?.providerSessionId === live.claudeSessionId) {
    // Two prompts in a row with nothing between them: the second follows the
    // first, not the entry before both.
    return last.claimed ? undefined : last.uuid;
  }
  return first && !last ? CLAUDE_FIRST_TURN : undefined;
}

function launchOptions(
  input: HarnessSessionInput,
  resume: string | undefined,
  sessionId: string,
  addDirs: string[],
  resumeSessionAt?: string,
): {
  model?: string;
  effort?: string;
  permissionMode?: ReturnType<typeof runtimeModeToPermission>;
  resume?: string;
  resumeSessionAt?: string;
  sessionId?: string;
  settings?: ClaudeCliSettings;
  addDirs?: string[];
  disallowedTools?: string[];
  disabledMcpServers?: string[];
  gatewayConnectors?: HarnessSessionInput["gatewayConnectors"];
  // [lane-1] launch-type
  forkSession?: boolean;
  // [lane-2] launch-type
  appendSystemPromptFile?: string;
  // [lane-3] launch-type
  // [lane-4] launch-type
  toolLoading?: "auto" | "upfront";
  // [lane-5] launch-type
} {
  const native = nativeModelId(input.model);
  const effortRaw = input.modelSettings?.effort;
  const context = input.modelSettings?.context;
  const settings: ClaudeCliSettings = {};
  if (input.modelSettings?.thinking === "true") {
    settings.alwaysThinkingEnabled = true;
  }
  if (input.modelSettings?.fast === "true") {
    settings.fastMode = true;
  }
  if (isClaudeUltracodeEffort(effortRaw)) {
    settings.ultracode = true;
  }
  if (!loadClaudeHooks()) {
    settings.disableAllHooks = true;
  }
  // Plugins switched off for the chat: `false` under `enabledPlugins` in
  // `--settings`, which Claude Code applies above the user, project and local
  // files for this process only.
  const enabledPlugins = claudePluginOverrides(input.disabledPlugins);
  if (enabledPlugins) {
    settings.enabledPlugins = enabledPlugins;
  }
  // [lane-1] launch-body
  // A fork resumes the source conversation once, as a copy. Once Claude has
  // bound the copy's own id, `resume` is that id and the fork is done.
  const fork_l1 = forkByThread_l1.get(input.sessionId);
  if (fork_l1 && fork_l1 !== resume) forkByThread_l1.delete(input.sessionId);
  const forkSession_l1 = fork_l1 !== undefined && fork_l1 === resume;
  // [lane-2] launch-body
  const agentsMd_l2 = agentsMdPluginConfig_l2(input.agentsMdPlugin);
  if (agentsMd_l2) settings.pluginConfigs = agentsMd_l2;
  // [lane-3] launch-body
  // [lane-4] launch-body
  // [lane-5] launch-body
  return {
    model: resolveClaudeApiModelId(native, context),
    effort: normalizeClaudeCliEffort(effortRaw, native),
    permissionMode:
      input.intent === "plan"
        ? "plan"
        : runtimeModeToPermission(input.runtimeMode),
    resume,
    ...(resume && resumeSessionAt ? { resumeSessionAt } : {}),
    sessionId: resume ? undefined : sessionId,
    settings: Object.keys(settings).length > 0 ? settings : undefined,
    addDirs,
    // Tools blocked for the chat leave the model's tool list. "Always allow"
    // rules are not passed as `--allowedTools`: an allow rule on the command
    // line could let a plan turn act, and the permission handler applies
    // them without a restart.
    // Skills switched off for the chat are denied to the model the same way.
    disallowedTools: [
      ...claudeToolDenyRules(input.toolAccess?.never),
      ...claudeSkillDenyRules(input.disabledSkills),
    ],
    disabledMcpServers: input.disabledMcpServers,
    gatewayConnectors: input.gatewayConnectors,
    // [lane-1] launch-return
    ...(forkSession_l1 ? { forkSession: true } : {}),
    // [lane-2] launch-return
    ...(input.preambleFile && !resume
      ? { appendSystemPromptFile: input.preambleFile }
      : {}),
    // [lane-3] launch-return
    // [lane-4] launch-return
    toolLoading: loadClaudeToolLoading_l4(),
    // [lane-5] launch-return
  };
}

/** Exported for tests. */
export function __claudeTestReset(): void {
  liveByThread.clear();
  resumeByThread.clear();
  tasksByThread.clear();
  cancelledThreads.clear();
  lastEntryByThread.clear();
  rewindByThread.clear();
}
// [lane-1] exports
/**
 * Chats waiting to start as a fork, by MonoCode session id, with the source
 * Claude conversation they copy. In memory only: a fork must get its first
 * prompt before the app restarts (see `prepareClaudeFork_l1`).
 */
const forkByThread_l1 = new Map<string, string>();

/**
 * Makes the next start of `threadId` a fork of another Claude conversation:
 * `--resume <source> --fork-session`, and `--resume-session-at <at>` to copy
 * it only up to an entry. The source conversation is never written to.
 */
export function prepareClaudeFork_l1(input: {
  threadId: string;
  providerSessionId: string;
  cwd: string;
  providerAccountId?: string;
  at?: string;
}): void {
  const source = input.providerSessionId.trim();
  if (!input.threadId || !source || !input.cwd.trim()) {
    throw new Error("Nothing to fork: the chat has no Claude conversation");
  }
  if (liveByThread.has(input.threadId)) {
    throw new Error("The new chat is already running");
  }
  forkByThread_l1.set(input.threadId, source);
  resumeByThread.set(input.threadId, {
    sessionId: source,
    cwd: input.cwd,
    providerAccountId: input.providerAccountId,
  });
  const at = input.at?.trim();
  if (at && at !== CLAUDE_FIRST_TURN) {
    rewindByThread.set(input.threadId, { providerSessionId: source, at });
  } else {
    rewindByThread.delete(input.threadId);
  }
}

/** The adapter's `forkSession`: the copy binds its own id on its first start. */
export async function forkClaudeSession_l1(input: {
  sourceSessionId: string;
  newSessionId: string;
  providerSessionId: string;
  cwd: string;
  providerAccountId?: string;
  boundary?: string;
}): Promise<{ providerSessionId?: string }> {
  if (liveByThread.get(input.sourceSessionId)?.activeTurn) {
    throw new Error("Stop the current turn before forking");
  }
  prepareClaudeFork_l1({
    threadId: input.newSessionId,
    providerSessionId: input.providerSessionId,
    cwd: input.cwd,
    providerAccountId: input.providerAccountId,
    at: input.boundary,
  });
  return {};
}

/** Test seam. */
export function __claudeForkPending_l1(threadId: string): string | undefined {
  return forkByThread_l1.get(threadId);
}
/**
 * Stops one task Claude Code runs beside the turn, by its task id, with the
 * same `stop_task` request a cancel sends for all of them. False when the
 * session or the task is not live.
 */
export async function stopClaudeBackgroundTask_l1(
  sessionId: string,
  taskId: string,
): Promise<boolean> {
  const live = liveByThread.get(sessionId);
  if (!live || live.exited || !live.backgroundTasks.has(taskId)) return false;
  await writeJson(
    sessionId,
    buildControlRequest(nextControlId(live), {
      subtype: "stop_task",
      task_id: taskId,
    }),
  );
  return true;
}
// [lane-2] exports
// [lane-3] exports
// [lane-4] exports
// [lane-5] exports
async function claudeRuleHeldToFolders_l5(
  live: Live,
  toolName: string,
  input: Record<string, unknown>,
): Promise<boolean> {
  const path = claudeWritePath_l5(toolName, input);
  if (path === undefined) return true;
  return pathsInsideChatFolders_l5(
    path === null ? null : [path],
    live.chatFolders_l5,
  );
}

/** The fingerprint a package script rule is kept with, read now (R3). */
function chatRuleScriptPrint_s6(
  ruleKey: string,
  cwd: string,
): Promise<{ ruleKey: string; fingerprint: string } | undefined> | undefined {
  const rule = commandRuleFromKey(ruleKey);
  const script = rule ? packageScriptOf(rule) : null;
  if (script === null) return undefined;
  return packageScriptFingerprint(cwd, script).then(
    (fingerprint) => (fingerprint ? { ruleKey, fingerprint } : undefined),
    () => undefined,
  );
}

/**
 * The card's rule, held to the scripts in the project's `package.json` (R4).
 * Waits only for a package script prefix rule, so other cards are not held.
 */
function heldChatRule_s6(
  chatRule: ApprovalTool | undefined,
  command: unknown,
  cwd: string,
): ApprovalTool | undefined | Promise<ApprovalTool | undefined> {
  const rule = chatRule ? commandRuleFromKey(chatRule.key) : null;
  if (!rule || rule.kind !== "prefix" || packageScriptOf(rule) === null)
    return chatRule;
  return ruleHeldToProjectScripts(rule, command, cwd).then(
    (held) => (held ? approvalTool(commandRuleKey(held)) : undefined),
    () => undefined,
  );
}
