import { dropContextWindow, type ContextUsage } from "./contextUsage";
import type { UserQuestionPrompt } from "./userQuestion";
import type { HandoffComposerCard } from "./handoff";
import type { InboxComposerCard } from "../../inbox/model/githubTasks";
import type { InboxAskContext } from "../../inbox/model/inboxAsk";
import type { NoteCardMeta, NoteComposerCard } from "../../notes";
import type { OrchestrationProposal } from "../../orchestration/model/orchestrationPlan";
import type { LinkedWorkItemUpdateCard } from "../../inbox/model/linkedWorkItemActivity";
import type { ToolImageRef } from "../../tool-images/model/toolImages";
import type { ResearchRequest } from "../../research-mode/model/researchPrompt";
import {
  defaultSessionChoice,
  firstEnabledHarness,
  preferredModelId,
  preferredModelSettings,
  resolveModel,
} from "./models";
import { loadProjectProviderSettings } from "./projectProviders";

export type HarnessId =
  | "claude"
  | "codex"
  | "cursor"
  | "grok"
  | "opencode"
  | "pi"
  | "omp"
  | "fx"
  | "hermes"
  | "antigravity";

export const HARNESSES: HarnessId[] = [
  "claude",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "pi",
  "omp",
  "fx",
  "hermes",
  "antigravity",
];

export type BlockRole =
  | "user"
  | "assistant"
  | "image"
  | "reasoning"
  | "tool"
  | "approval"
  | "tasks"
  | "plan"
  | "system"
  | "handoff";

/** A session created by a Mono during this conversation turn. */
export type MonoSpawnedSession = {
  sessionId: string;
  cwd: string;
  title: string;
  harness: HarnessId;
  model: string;
};

export type TaskListItemStatus =
  "pending" | "in_progress" | "completed" | "cancelled";

export type TaskListItem = {
  /** Stable provider identity, when available, for merging status-only updates. */
  id?: string;
  text: string;
  status: TaskListItemStatus;
};

export type TaskListMeta = {
  /** Provider identity for replacing later snapshots of the same list. */
  key?: string;
  /** Provider conversation that produced this list, when the provider scopes task ids to one. */
  providerSessionId?: string;
  explanation?: string;
  items: TaskListItem[];
};

/** One-shot behavior selected in the composer for the next harness turn. */
export type TurnIntent = "default" | "plan" | "build" | "orchestrate";
export type EditedResendRejection = {
  /** The provider removed the old turn, so retry as a normal unsent prompt. */
  providerRewound: boolean;
};
export type ComposerTurnOptions = {
  intent?: TurnIntent;
  resendEdited?: boolean;
  /** Restore an edited prompt when the resend rejects asynchronously. */
  onResendRejected?: (recovery: EditedResendRejection) => void;
  /** Promote an existing unsent transcript block instead of appending a turn. */
  draftBlockId?: string;
  /** Send this message as research: the harness gets research instructions. */
  research?: ResearchRequest;
};

export type PlanStatus = "streaming" | "ready" | "building" | "built";

export type PlanBlockMeta = {
  /** Provider or turn identity used to merge streamed snapshots. */
  key?: string;
  status: PlanStatus;
  /** Provider-authored plan before any user edits. */
  originalText?: string;
  /** Exact markdown the user approved with Build. */
  approvedText?: string;
  edited?: boolean;
};

export type ModelTarget = {
  harness: HarnessId;
  model: string;
  modelSettings: Record<string, string>;
};

export type PlanBuildTarget = ModelTarget;

export type HandoffStatus = "preparing" | "ready";

export type HandoffMeta = {
  from: HarnessId;
  to: HarnessId;
  status: HandoffStatus;
  /** Inject this brief into prompts to `to` until that harness accepts a turn. */
  pending?: boolean;
};

/** One persisted question/answer in a completed turn's side conversation. */
export type BtwMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  /** Rich harness activity for assistant replies, when available. */
  blocks?: Block[];
};

export type BtwThreadStatus = "running" | "ready" | "error";

/** Independent, read-only "by the way" conversation anchored to a turn. */
export type BtwThread = {
  id: string;
  sourceEndBlockId: string;
  createdAt: number;
  updatedAt: number;
  status: BtwThreadStatus;
  messages: BtwMessage[];
  /** Provider that answered this side thread. */
  harness?: HarnessId;
  /** Selected harness model for this side thread; absent means session default. */
  model?: string;
  /** Provider settings selected for this side thread's model. */
  modelSettings?: Record<string, string>;
  /** Provider-specific side-thread id when the text runner supports resume. */
  providerThreadId?: string;
  error?: string;
  /** Live harness blocks for the in-flight reply; not persisted. */
  pendingBlocks?: Block[];
};

/** Compact transcript card for a second-opinion or split-pane handoff turn. */
export type SecondOpinionMeta = {
  from: HarnessId;
  to: HarnessId;
  request?: string;
  files?: number;
  /** Split-pane continue. Default is a second-opinion review. */
  kind?: "handoff";
};

/** A mid-turn interjection the harness asked to surface, e.g. OMP advisor notes. */
export type InterjectionSeverity = "nit" | "concern" | "blocker";

export type InterjectionMeta = {
  customType: string;
  /** Highest severity among this interjection's retained notes, when any is known. */
  severity?: InterjectionSeverity;
};

export type ToolPreviewKind = "read" | "write" | "shell" | "search";

export type ToolPreviewLineKind = "add" | "del" | "context";

export type ToolPreviewLine = {
  number?: number;
  kind: ToolPreviewLineKind;
  text: string;
};

export type ToolPreview = {
  kind: ToolPreviewKind;
  title?: string;
  path?: string;
  fileName?: string;
  startLine?: number;
  additions?: number;
  deletions?: number;
  /** Write supplied new contents without the previous file to compare. */
  contentOnly?: boolean;
  query?: string;
  lines?: ToolPreviewLine[];
  output?: string;
};

/** One thing a subagent did, mirrored into the parent transcript. */
export type AgentStepKind = "tool" | "message" | "reasoning";

export type AgentStep = {
  /** Provider step identity, so repeats merge instead of stacking up. */
  id: string;
  kind: AgentStepKind;
  /** Tool label, or the prose the subagent wrote. */
  text: string;
  toolKind?: string;
  status?: string;
  detail?: string;
  preview?: ToolPreview;
};

/**
 * The inside of a delegated run: what the subagent is called, and the trail it
 * left. Held on the parent Agent tool block so the transcript can open it
 * without a second session.
 */
export type AgentRunMeta = {
  /** What the subagent is called, e.g. "Correctness review". */
  name: string;
  /** Provider agent type, e.g. "code-reviewer". */
  agentType?: string;
  /** Model reported for the child, which may differ from its parent. */
  model?: string;
  steps: AgentStep[];
};

export type AttachmentKind = "image" | "audio" | "file";

export type GeneratedImageMeta = {
  path: string;
  name: string;
  mimeType: string;
  size: number;
  alt?: string;
};

export type Attachment = {
  /** Live transcript only; deliberately excluded from persisted attachments. */
  copyFromPath?: boolean;
  id: string;
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  size: number;
  /** Absolute path when the file lives on disk. */
  path?: string;
  /** Base64 payload for vision images (and pasted blobs) sent to the harness. */
  data?: string;
  /** Object URL for in-session thumbnails. Not persisted. */
  previewUrl?: string;
};

export type MonoSessionCompletion = {
  sessionId: string;
  title: string;
  status: "completed" | "failed" | "cancelled";
  /** A single report covering several sessions launched in one Mono turn. */
  sessionCount?: number;
};

export type QueuedMessage = {
  id: string;
  /** User bubble already shown optimistically in a Mono's conversation. */
  blockId?: string;
  text: string;
  attachments: Attachment[];
  noteCard?: NoteComposerCard;
  handoffCard?: HandoffComposerCard;
  intent?: TurnIntent;
  research?: ResearchRequest;
  /** An app notification that must wait for an idle Mono, never steer its work. */
  monoSessionCompletion?: MonoSessionCompletion;
  /** Delivery failed; the message remains available to retry or edit. */
  error?: string;
};

export type MessageQueueStatus = "active" | "paused" | "resuming";

/** The provider stopped the last turn at a usage limit. */
export type UsageLimit = {
  /** Epoch ms when the provider's window resets, once known. */
  resetsAt?: number;
  /** Send a continue turn once the window resets. */
  resumeAtReset?: boolean;
};

/** Provider/model provenance captured when a user turn is submitted. */
export type TurnModel = {
  harness: HarnessId;
  id: string;
  name: string;
};

/** Provider-reported token accounting for one user turn. */
export type TurnMetrics = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Provider-normalized share of input served from cache, as a percentage. */
  cacheHitPercent?: number;
};

export type Block = {
  id: string;
  role: BlockRole;
  text: string;
  image?: GeneratedImageMeta;
  attachments?: Attachment[];
  streaming?: boolean;
  /** Epoch ms when this user turn started. */
  startedAt?: number;
  /** How long the agent worked on this user turn, in ms. */
  durationMs?: number;
  /** Epoch ms when this message joined a turn that was already running. */
  sentAt?: number;
  /** Stable model label for this turn. Present on newly created user blocks. */
  turnModel?: TurnModel;
  /** Provider turn boundary used to replace this user message, when known. */
  providerTurnId?: string;
  /** User turn saved to the session but not submitted to the harness yet. */
  draft?: boolean;
  /** This user turn activated MonoCode app access for its thread. */
  monocode?: boolean;
  /** The Plan or Orchestrator mode this user turn was sent in. */
  intent?: Extract<TurnIntent, "plan" | "orchestrate">;
  /** This user turn was sent in research mode. */
  research?: true;
  /** Stable CLI request that submitted this turn, for safe retries. */
  appRequestId?: string;
  /** Provider-reported token metrics for this user turn, when available. */
  turnMetrics?: TurnMetrics;
  tool?: {
    callId?: string;
    title?: string;
    kind?: string;
    status?: string;
    detail?: string;
    preview?: ToolPreview;
    /** Left running by the agent when it yielded; the turn waits on it. */
    background?: boolean;
  };
  /**
   * Images this tool call returned, kept as files for the transcript. On a
   * subagent's row: the images its own tool calls returned.
   */
  toolImages?: ToolImageRef[];
  approval?: {
    requestId: number;
    decided?: "allow" | "deny" | "cancelled";
    /** What the request is for, where the harness names it; see `ToolAccess`. */
    tool?: ApprovalTool;
  };
  /** Inner activity of a delegated run. Present on Agent/Task tool blocks. */
  agentRun?: AgentRunMeta;
  taskList?: TaskListMeta;
  plan?: PlanBlockMeta;
  orchestration?: OrchestrationProposal;
  /** Parent conversation for an internal orchestration worker. */
  orchestrationLeadId?: string;
  /**
   * A turn the app wrote on the user's behalf to keep an orchestration moving.
   * The harness needs it; the transcript hides it, so a run reads as one
   * conversation rather than the user narrating their own agents.
   */
  internal?: boolean;
  /** Hidden app prompt that starts a separate completion report in a Mono chat. */
  monoSessionCompletion?: MonoSessionCompletion;
  /** Accepted session launches, kept on the originating user turn. */
  monoSpawnedSessions?: MonoSpawnedSession[];
  handoff?: HandoffMeta;
  secondOpinion?: SecondOpinionMeta;
  /** Independent read-only side conversations anchored to this user turn. */
  btwThreads?: BtwThread[];
  noteCard?: NoteCardMeta;
  /** Saved artifacts attached to this turn; their bodies live outside chat. */
  artifactCards?: import("../../artifacts/artifacts").ArtifactCard[];
  /** Exact CI repair instructions and evidence supplied with this user turn. */
  ciContext?: string;
  /** Mid-turn interjection chrome; system blocks only. Body lives in text. */
  interjection?: InterjectionMeta;
  /**
   * A system row the reader must not miss — an error or an interruption —
   * rather than turn chrome like a status ping. Never folds into the trail.
   */
  notice?: "error" | "interrupt";
  statusKey?: string;
  /** Posted to a Mono's chat by one of its habits, outside any turn. */
  monoHabit?: { id: string; name: string; at: number };
  /** A card a Mono put in its chat; see `features/monos/model/monoCards`. */
  monoCard?: import("../../monos/model/monoCards").MonoCard;
  /**
   * Storage carrier for the session's composer tools. The session store writes
   * it onto the first user block when saving and lifts it back onto the session
   * when loading, so it is never present on a live block.
   */
  sessionTools?: PersistedSessionTools;
};

/** Session-level composer tools saved with the transcript. */
export type PersistedSessionTools = {
  extraDirs?: string[];
  disabledMcpServers?: string[];
  toolAccess?: ToolAccess;
  disabledSkills?: string[];
  disabledPlugins?: string[];
};

/** A standing answer for one tool's approval requests in one chat. */
export type ToolAccessRule = "always" | "never";

/**
 * Per-chat rules by tool key. A tool without a rule follows the session's
 * permission mode. Keys are the harness's own names: a Claude Code tool name
 * (`Bash`, `mcp__server__tool`), or `codex:command` and `codex:file-change`.
 */
export type ToolAccess = Record<string, ToolAccessRule>;

/** The tool an approval request is about: its rule key and a name to show. */
export type ApprovalTool = { key: string; label: string };

export type RuntimeMode =
  "supervised" | "auto-accept-edits" | "auto" | "full-access";

/** One GitHub issue or pull request associated with a coding session. */
export type LinkedWorkItem = {
  kind: "issue" | "pr";
  repo: string;
  number: number;
  url: string;
};

export const RUNTIME_MODES: RuntimeMode[] = [
  "supervised",
  "auto-accept-edits",
  "auto",
  "full-access",
];

export const DEFAULT_RUNTIME_MODE: RuntimeMode = "supervised";

export const RUNTIME_MODE_LABEL: Record<RuntimeMode, string> = {
  supervised: "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

export const RUNTIME_MODE_HINT: Record<RuntimeMode, string> = {
  supervised: "Ask before commands and file changes.",
  "auto-accept-edits": "Auto-approve edits, ask before other actions.",
  auto: "An AI reviewer can approve or deny actions.",
  "full-access":
    "Allow commands, edits, and supported MCP confirmations in non-plan turns without prompts.",
};

export type WorkspaceMode = "current" | "worktree";

export type Session = {
  /** Saved and accessible by id, but omitted from the normal session sidebar. */
  sidebarHidden?: boolean;
  /** Receipt for an acknowledged floating-composer handoff. */
  quickLaunchAccepted?: boolean;
  /** Internal worker: displayed in its lead's panel rather than a workspace tab. */
  orchestrationLeadId?: string;
  /** Temporary Inbox conversation: shares the runtime, never saved as a session. */
  inboxAsk?: InboxAskContext;
  id: string;
  harness: HarnessId;
  model: string;
  modelSettings: Record<string, string>;
  runtimeMode: RuntimeMode;
  title: string;
  /** Project / working directory for this session. */
  cwd: string;
  blocks: Block[];
  /** Mono-only database window. Older blocks are fetched separately by the viewer. */
  monoTranscript?: { before: number | null; firstBlockId: string | null };
  /** True while a harness turn is in flight. */
  busy?: boolean;
  /**
   * The last prompt was edited and is on its way back to the harness. Until
   * the harness takes it, the turn on show is the one about to be replaced.
   * In-memory only.
   */
  resendingEdited?: boolean;
  /** The provider has accepted this turn and can take live follow-ups. */
  turnReady?: boolean;
  /**
   * What the live turn is waiting on after the agent yielded with work still
   * running in the background. In-memory only.
   */
  backgroundTasks?: string[];
  /** Follow-ups retained until they have been delivered. */
  queuedMessages?: QueuedMessage[];
  /** Paused after user stops current turn; resuming waits for continued turn. */
  queueStatus?: MessageQueueStatus;
  /** Prevent auto-dispatch while this queued row is being edited. In-memory only. */
  editingQueuedMessageId?: string;
  /** Pending delivery locks this row against edits and deletion. Not persisted. */
  sendingQueuedMessageId?: string;
  /** Last turn hit a provider usage limit; cleared by the next send. In-memory only. */
  usageLimit?: UsageLimit;
  /**
   * Lives only in memory: never saved, never listed with the project's chats.
   * A Mono's habit runs are, and disappear when the run ends.
   */
  ephemeral?: boolean;
  /** Provider-side conversation id (Cursor ACP session id). */
  providerSessionId?: string;
  /** Named local credential profile used by Claude or Codex. */
  providerAccountId?: string;
  /** Context-window level reported by the harness. Absent until it reports. */
  context?: ContextUsage;
  /**
   * Composer switched providers, but the previous child is still live.
   * Handoff runs on the next send, not on picker change.
   */
  pendingSwitch?: PendingHarnessSwitch;
  /** Last known branch in the session's working copy. */
  branch?: string;
  /** Selected working copy; cwd remains the project identity. */
  worktreeCwd?: string;
  /** Blank-composer choice; consumed when the first turn starts. */
  workspaceMode?: WorkspaceMode;
  /** Base ref for a worktree that will be created on first send. */
  worktreeBase?: string;
  /** Internal guard while the first turn creates its selected worktree. */
  worktreePreparing?: boolean;
  /** Select a working copy before continuing after the previous one was deleted. */
  worktreeRemoved?: boolean;
  /**
   * Extra folders (absolute paths) the agent may work in besides its working
   * directory. Saved on the first user block; see `sessionStore`.
   */
  extraDirs?: string[];
  /**
   * MCP servers (by configured name) switched off for this chat only. The
   * harness's own configuration is left alone. Saved like `extraDirs`.
   */
  disabledMcpServers?: string[];
  /**
   * Tools always allowed or never allowed in this chat only, whatever the
   * permission mode says. Saved like `extraDirs`.
   */
  toolAccess?: ToolAccess;
  /**
   * Skills (by name) switched off for this chat only. The app-wide list in
   * Settings is left alone. Saved like `extraDirs`.
   */
  disabledSkills?: string[];
  /**
   * Claude Code plugins (by `name@marketplace` id) switched off for this chat
   * only. Claude Code's own settings are left alone. Saved like `extraDirs`.
   */
  disabledPlugins?: string[];
  /** One-shot composer text when opening a session from Inbox. */
  composerSeed?: string;
  /** Inbox issue/PR chip shown above the composer. In-memory, one-shot. */
  inboxCard?: InboxComposerCard;
  /** GitHub issue or pull request shown on the persisted session card. */
  linkedWorkItem?: LinkedWorkItem;
  /** Automation that created or last launched this session. */
  automationId?: string;
  /** New linked-item activity shown above the composer. In-memory, one-shot. */
  linkedWorkItemUpdateCard?: LinkedWorkItemUpdateCard;
  /** Note chip shown above the composer. In-memory, one-shot. */
  noteCard?: NoteComposerCard;
  /** Handoff chip shown above the composer. In-memory, one-shot. */
  handoffCard?: HandoffComposerCard;
  /**
   * Live clarifying questions from AskUserQuestion / ask_question / etc.
   * In-memory; request ids do not survive restarts.
   */
  pendingQuestion?: UserQuestionPrompt;
};

export type PendingHarnessSwitch = {
  from: HarnessId;
  fromModel: string;
  fromSettings: Record<string, string>;
  fromProviderSessionId?: string;
  fromProviderAccountId?: string;
  /** The outgoing provider is exhausted; build the recap from the transcript. */
  skipOutgoingRecap?: boolean;
};

export const HARNESS_LABEL: Record<HarnessId, string> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor",
  grok: "grok",
  opencode: "opencode",
  pi: "pi",
  omp: "omp",
  fx: "fx",
  hermes: "hermes",
  antigravity: "antigravity",
};

export const HARNESS_TITLE: Record<HarnessId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok Build",
  opencode: "OpenCode",
  pi: "Pi",
  omp: "omp",
  fx: "fx",
  hermes: "Hermes Agent",
  antigravity: "Antigravity",
};

/** fx ACP rejects attachment prompt blocks. */
export function harnessSupportsAttachments(id: HarnessId): boolean {
  return id !== "fx";
}

/** Harnesses MonoCode can hand extra working directories to. */
export function harnessSupportsExtraDirs(id: HarnessId): boolean {
  return id === "claude" || id === "codex";
}

/** Harnesses that can leave out one MCP server for a single conversation. */
export function harnessSupportsConnectorSwitches(id: HarnessId): boolean {
  return id === "claude" || id === "codex";
}

/**
 * Harnesses whose approval requests name a tool MonoCode can keep a per-chat
 * rule for. The others either do not ask or do not say what they ask about.
 */
export function harnessSupportsToolAccess(id: HarnessId): boolean {
  return id === "claude" || id === "codex";
}

/**
 * Harnesses whose `/name` skills MonoCode offers and expands itself, so one
 * chat can leave a skill out. Pi and omp run their own commands: MonoCode
 * passes `/name` through to them and cannot hold one back.
 */
export function harnessSupportsSkillSwitches(id: HarnessId): boolean {
  return id !== "pi" && id !== "omp";
}

export function newSession(
  harness: HarnessId = "claude",
  cwd = "~",
  model?: string,
  runtimeMode: RuntimeMode = DEFAULT_RUNTIME_MODE,
  modelSettings?: Record<string, string>,
): Session {
  const resolved = resolveModel(harness, model ?? preferredModelId(harness));
  return {
    id: crypto.randomUUID(),
    harness,
    model: resolved.id,
    modelSettings: preferredModelSettings(resolved, modelSettings),
    runtimeMode,
    title: HARNESS_LABEL[harness],
    cwd,
    blocks: [],
  };
}

/** New conversation using the Providers defaults. */
export function newDefaultSession(
  cwd = "~",
  runtimeMode: RuntimeMode = DEFAULT_RUNTIME_MODE,
): Session {
  const choice = defaultSessionChoice(cwd);
  return newSession(choice.harness, cwd, choice.model, runtimeMode);
}

/**
 * Provider and model a seeded session should use in `cwd`. The project's own
 * default provider and model win over the seed; when the project has neither,
 * the seed's provider and model are carried. A provider the project hides is
 * swapped for its first enabled one.
 */
function projectSessionChoice(
  seed: Pick<Session, "harness" | "model"> | undefined,
  cwd: string,
): { harness: HarnessId; model?: string } {
  const project = loadProjectProviderSettings(cwd);
  const seedHarness = seed?.harness ?? "claude";
  const harness = firstEnabledHarness(
    cwd,
    project.defaultHarness ?? seedHarness,
  );
  const model =
    project.models?.[harness] ??
    (project.defaultHarness === harness ? project.defaultModel : undefined) ??
    (project.defaultHarness == null && harness === seedHarness
      ? seed?.model
      : undefined);
  return { harness, model };
}

/**
 * New conversation for a project. The project's default provider and model win
 * over the seed's; a provider the project has hidden is swapped for its first
 * enabled one.
 */
export function newSessionForProject(
  seed: Session | undefined,
  cwd: string,
): Session {
  const { harness, model } = projectSessionChoice(seed, cwd);
  const carriesSeed =
    model != null && model === seed?.model && harness === seed?.harness;
  return newSession(
    harness,
    cwd,
    model,
    seed?.runtimeMode,
    carriesSeed ? seed?.modelSettings : undefined,
  );
}

/**
 * Retarget an existing session (typically a blank one) to a project, adopting
 * that project's provider defaults while keeping its id, blocks and composer
 * seed.
 */
export function retargetSessionToProject(
  session: Session,
  cwd: string,
): Session {
  const { harness, model } = projectSessionChoice(session, cwd);
  const resolved = resolveModel(harness, model ?? preferredModelId(harness));
  const carriesSeed =
    model != null && model === session.model && harness === session.harness;
  return {
    ...session,
    cwd,
    harness,
    model: resolved.id,
    modelSettings: preferredModelSettings(
      resolved,
      carriesSeed ? session.modelSettings : undefined,
    ),
    title: HARNESS_LABEL[harness],
    ...(harness === session.harness
      ? {}
      : { providerSessionId: undefined, providerAccountId: undefined }),
    ...(resolved.id === session.model
      ? {}
      : { context: dropContextWindow(session.context) }),
  };
}

/** New conversation carrying another session's harness, model and settings. */
export function newSessionLike(
  seed: Session | undefined,
  cwd: string,
): Session {
  return newSession(
    seed?.harness ?? "claude",
    cwd,
    seed?.model,
    seed?.runtimeMode,
    seed?.modelSettings,
  );
}

/** First line of a prompt, truncated for the tab strip. */
export function titleFromPrompt(
  prompt: string,
  harness: HarnessId,
  attachments: Attachment[] = [],
): string {
  const line = prompt.trim().split(/\r?\n/)[0]?.trim() ?? "";
  const fromFiles =
    !line && attachments.length > 0
      ? attachments
          .map((file) => file.name)
          .filter(Boolean)
          .slice(0, 3)
          .join(", ")
      : "";
  const seed = line || fromFiles;
  if (!seed) return HARNESS_LABEL[harness];
  const max = 72;
  const short = seed.length > max ? `${seed.slice(0, max - 1)}…` : seed;
  return formatSessionTitle(harness, short);
}

export function formatSessionTitle(harness: HarnessId, title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return HARNESS_LABEL[harness];
  return `${HARNESS_LABEL[harness]} · ${trimmed}`;
}

/** True when the stored title is still a placeholder the LLM may replace. */
export function canReplaceSessionTitle(
  current: string,
  harness: HarnessId,
  seed: string,
): boolean {
  return (
    current === seed ||
    current === HARNESS_LABEL[harness] ||
    current === HARNESS_TITLE[harness]
  );
}

export function hasPendingApproval(blocks: Block[]): boolean {
  return blocks.some((block) => block.approval && !block.approval.decided);
}

export function sessionNeedsInput(session: Session): boolean {
  return (
    !session.worktreeRemoved &&
    (hasPendingApproval(session.blocks) || session.pendingQuestion != null)
  );
}

/** The single unsent user turn held by a session, when present. */
export function sessionDraftBlock(
  session: Pick<Session, "blocks">,
): Block | undefined {
  return session.blocks.find((block) => block.role === "user" && block.draft);
}

/** Remove one saved draft without disturbing the conversation before it. */
export function removeSessionDraft(
  session: Session,
  draftBlockId: string,
): Session | undefined {
  const draft = session.blocks.find(
    (block) =>
      block.id === draftBlockId && block.role === "user" && block.draft,
  );
  if (!draft) return undefined;
  const blocks = session.blocks.filter((block) => block.id !== draftBlockId);
  const draftTitle = titleFromPrompt(
    draft.text,
    session.harness,
    draft.attachments,
  );
  return {
    ...session,
    blocks,
    title:
      blocks.length === 0 && session.title === draftTitle
        ? HARNESS_LABEL[session.harness]
        : session.title,
  };
}

/** Title without the harness prefix stored for the tab strip. */
export function sessionDisplayTitle(title: string, harness: HarnessId): string {
  const prefix = `${HARNESS_LABEL[harness]} · `;
  if (title.startsWith(prefix)) return title.slice(prefix.length);
  if (title === HARNESS_LABEL[harness] || title === HARNESS_TITLE[harness]) {
    return "New session";
  }
  return title;
}

/** Working copy the agent and session git UIs should use. */
export function sessionWorkCwd(session: {
  cwd: string;
  worktreeCwd?: string;
}): string {
  return session.worktreeCwd || session.cwd;
}
