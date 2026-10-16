import type {
  AgentStepKind,
  ApprovalTool,
  Attachment,
  InterjectionMeta,
  RuntimeMode,
  TaskListItem,
  ToolPreview,
  TurnIntent,
  TurnMetrics,
} from "../../../features/sessions/model/session";
import type { UserQuestion } from "../../../features/sessions/model/userQuestion";
import type { ToolImageRef } from "../../../features/tool-images/model/toolImages";

export type HarnessEvent =
  | { type: "session.started" }
  | { type: "session.ended"; code?: number | null }
  | { type: "session.error"; message: string }
  | { type: "session.providerBound"; providerSessionId: string }
  | { type: "turn.started"; providerTurnId: string }
  | { type: "turn.ready" }
  | {
      type: "session.configChanged";
      model?: string;
      modelSettings?: Record<string, string>;
    }
  | { type: "status"; text: string; key?: string }
  /** The provider refused the turn until its usage window resets (epoch ms). */
  | { type: "usage.limited"; resetsAt?: number }
  /**
   * The agent has yielded but the turn is not over: work it started is still
   * running and will wake it again. Empty once it is back at work.
   */
  | { type: "background.updated"; tasks: string[] }
  | ({ type: "interjection"; text: string } & InterjectionMeta)
  | { type: "message.delta"; text: string }
  | { type: "message.completed" }
  | {
      type: "image.generated";
      itemId: string;
      data: string;
      name: string;
      alt?: string;
    }
  | {
      type: "image.generated";
      itemId: string;
      path: string;
      name: string;
      mimeType: string;
      size: number;
      alt?: string;
    }
  | { type: "reasoning.delta"; text: string }
  | { type: "reasoning.completed" }
  | {
      type: "tool.started";
      agentModel?: string;
      callId: string;
      title: string;
      kind?: string;
      status?: string;
      /** Work the agent left running when it yielded. */
      background?: boolean;
      /** The raw shell command, when the harness gives one. Untrusted text. */
      command?: string;
      preview?: ToolPreview;
      /** Every path affected when one structured edit changes multiple files. */
      paths?: string[];
    }
  | {
      type: "tool.updated";
      agentModel?: string;
      callId: string;
      title?: string;
      kind?: string;
      status?: string;
      detail?: string;
      /**
       * `detail` is the next piece of a running call's output, to add to what
       * the call has printed so far. Without it, `detail` replaces the last.
       */
      append?: boolean;
      /** The raw shell command, when the harness gives one. Untrusted text. */
      command?: string;
      preview?: ToolPreview;
      /** Every path affected when one structured edit changes multiple files. */
      paths?: string[];
    }
  /**
   * Images a tool call returned, once the image store has saved them. For a
   * subagent's own tool call, `callId` is the parent Agent call.
   */
  | {
      type: "tool.images";
      callId: string;
      images: ToolImageRef[];
      /** Files deleted to keep the session under its limit. */
      dropped?: string[];
    }
  /** Something a subagent did, mirrored onto its parent Agent tool call. */
  | {
      type: "agent.step";
      /** Tool call id of the parent Agent/Task call. */
      callId: string;
      /** Provider step identity; repeats merge onto the same row. */
      stepId: string;
      kind: AgentStepKind;
      text: string;
      /** Tool kind for a "tool" step, so it gets the right icon. */
      toolKind?: string;
      status?: string;
      detail?: string;
      preview?: ToolPreview;
      /** The subagent's own name, when the provider only reveals it here. */
      agentName?: string;
      agentType?: string;
    }
  | {
      type: "approval.requested";
      requestId: number;
      title: string;
      kind?: string;
      callId?: string;
      preview?: ToolPreview;
      /**
       * The tool being asked about, when the harness names one a per-chat
       * rule can be kept for. Absent on requests no rule can answer.
       */
      tool?: ApprovalTool;
      /**
       * The narrower rule "Allow for this chat" keeps instead of `tool`, where
       * there is one: on Claude Code, a rule for this command's prefix.
       */
      chatRule?: ApprovalTool;
      /**
       * The network destination a sandboxed command asks to reach, when the
       * request is for network access. Untrusted harness text: show as plain
       * text only. `amendments` are the standing host rules the harness
       * proposed; the UI offers only an `allow` for this exact host.
       */
      network?: {
        host: string;
        protocol: string;
        amendments?: { host: string; action: "allow" | "deny" }[];
      };
      /**
       * An MCP server asks the user to sign in on a web page. Untrusted
       * server text: show as plain text, and open the page only on a click.
       */
      signIn?: { server: string; message: string; host: string; url: string };
      /**
       * A browser tool asks to open this host. The card keeps a site rule
       * under `chatKey` (the session) or `projectKey` (its folder), the keys
       * the adapter reads. Untrusted: plain text only.
       */
      site?: {
        server: string;
        host: string;
        chatKey: string;
        projectKey: string;
        /** False when no site rule may answer the call; see `SiteApproval`. */
        ruleable?: boolean;
        /** The call runs code in the browser. */
        code?: boolean;
        /** Every host the call names. */
        hosts?: string[];
        /** A web fetch: the address and the prompt, shown in full. */
        fetch?: { url: string; prompt: string };
      };
    }
  | {
      type: "approval.resolved";
      requestId: number;
      /** "cancelled" = a PermissionRequest hook decided before the user could. */
      decision: "allow" | "deny" | "cancelled";
    }
  | {
      type: "question.asked";
      requestId: number;
      title?: string;
      questions: UserQuestion[];
      callId?: string;
      autoResolveAt?: number;
    }
  | {
      type: "question.updated";
      requestId: number;
      autoResolveAt?: number;
    }
  | {
      type: "question.resolved";
      requestId: number;
      decision: "answered" | "skipped" | "cancelled";
    }
  | {
      type: "tasks.updated";
      key?: string;
      explanation?: string;
      /** Merge changed items into the existing list instead of replacing it. */
      merge?: boolean;
      /** This snapshot owns its labels, so a changed item text is a rename. */
      authoritative?: boolean;
      /** Provider conversation that owns these items. */
      providerSessionId?: string;
      items: TaskListItem[];
    }
  | {
      type: "plan";
      text: string;
      /** Merge identity for deltas and the authoritative completed item. */
      key?: string;
      /** Append a stream delta instead of replacing the current snapshot. */
      append?: boolean;
      /** False marks the plan ready for review. */
      streaming?: boolean;
    }
  /** Context-window level after the harness's latest request. */
  | { type: "context"; used?: number; window?: number }
  /** Provider token accounting for the active user turn. */
  | ({ type: "turn.metrics" } & TurnMetrics)
  /**
   * Everything the harness runs beside the turn, for the Running section.
   * Unlike `background.updated`, it is sent while the agent works too.
   */
  | {
      type: "background.items";
      items: import("./background").BackgroundItem[];
    }
  /** MonoCode's own checkpoint for the turn the last user message started. */
  | { type: "turn.checkpoint"; checkpointTurnId: string }
;

export type ApprovalDecision = "allow" | "deny";

/**
 * A chat's per-tool rules in the shape a harness takes: the tool keys whose
 * approval requests are answered without asking the user.
 */
export type HarnessToolAccess = { always?: string[]; never?: string[] };

/** The turn is connecting or has just ended; retain the follow-up for later. */
export class TurnNotReadyError extends Error {}

/**
 * A stdio MCP server MonoCode adds to a conversation at launch, beside the
 * harness's own servers.
 */
export type HarnessLaunchMcpServer = {
  /** The MCP server name the harness sees. */
  name: string;
  command: string;
  args: string[];
};

export type HarnessSessionInput = {
  sessionId: string;
  cwd: string;
  model: string;
  modelSettings?: Record<string, string>;
  providerAccountId?: string;
  runtimeMode: RuntimeMode;
  /** Keep provider context in memory; MonoCode owns the saved transcript. */
  ephemeral?: boolean;
  /** Persist Codex context in MonoCode's private Mono store. */
  codexStore?: "mono";
  intent?: TurnIntent;
  /**
   * This session drives MonoCode's control CLI, which reaches the app over
   * loopback. Sandboxes deny network by default, so a lead that cannot open
   * that socket cannot supervise its agents at all.
   */
  controlsAgents?: boolean;
  /** Grants this normal turn access to MonoCode's scoped app CLI. */
  appAccess?: boolean;
  /**
   * Extra folders (absolute paths) the agent may read and write besides `cwd`.
   * Claude Code and Codex honor it; other harnesses ignore it.
   */
  extraDirs?: string[];
  /**
   * MCP servers, by configured name, to leave out of this conversation.
   * Claude Code and Codex honor it; other harnesses ignore it.
   */
  disabledMcpServers?: string[];
  /**
   * Docker MCP gateway connectors added to this conversation, one stdio
   * server each. Claude Code (non-isolated) and Codex honor it; other
   * harnesses ignore it.
   */
  gatewayConnectors?: HarnessLaunchMcpServer[];
  /**
   * Tools whose approval requests are answered by a per-chat rule instead of
   * the user. Claude Code and Codex honor it; other harnesses ignore it.
   * "Always" only skips a prompt: it never applies in a plan turn and never
   * grants access the permission mode withholds.
   */
  toolAccess?: HarnessToolAccess;
  /**
   * Skills, by name, the model must not invoke in this conversation. Only
   * Claude Code honors it, as deny rules for its Skill tool. MonoCode itself
   * keeps these out of the composer's `/` list and does not expand them.
   */
  disabledSkills?: string[];
  /**
   * Claude Code plugins, by `name@marketplace` id, switched off for this
   * conversation. Only Claude Code honors it, as `false` entries under
   * `enabledPlugins` in the `--settings` its process starts with.
   */
  disabledPlugins?: string[];
  /**
   * The model provider the chat picked, by the harness's own provider id.
   * No adapter reads it yet.
   */
  modelProvider?: string;
  onEvent: (event: HarnessEvent) => void;
  /**
   * F2: a file of MonoCode's instructions for Claude Code's
   * `--append-system-prompt-file`. Applied only when a new conversation
   * starts; later changes go in the message. Other harnesses ignore it.
   */
  preambleFile?: string;
  /**
   * F2: the same instructions as Codex `developerInstructions`, sent on
   * `thread/start` only. Other harnesses ignore it.
   */
  developerInstructions?: string;
  /**
   * #27: Claude Code's built-in AGENTS.md plugin id, so `AGENTS.md` loads
   * beside an existing `CLAUDE.md`. Absent leaves Claude Code's default.
   */
  agentsMdPlugin?: string;
  /**
   * A named permissions profile for the chat, by the harness's own id. Only
   * Codex honors it, in place of MonoCode's sandbox settings.
   */
  permissionsProfile?: string;
  // [w3-a] session-input
  // [w3-b] session-input
  // [w3-c] session-input
};

export type SendTurnInput = HarnessSessionInput & {
  text: string;
  attachments?: Attachment[];
  /** Called once the provider has accepted the user turn. */
  onAccepted?: () => void;
};

export type CompactContextInput = HarnessSessionInput;

export type SteerTurnInput = {
  sessionId: string;
  cwd: string;
  model: string;
  modelSettings?: Record<string, string>;
  text: string;
  attachments?: Attachment[];
};

export type RewindLastTurnInput = CompactContextInput & {
  /** Provider turn boundary for the visible user message, when known. */
  providerTurnId?: string;
  /** When set, Cursor may resend via session/edit_prompt in one RPC. */
  text?: string;
  attachments?: Attachment[];
};

export type RewindLastTurnResult = {
  /** True when the harness already ran the replacement turn. */
  submitted: boolean;
};

/** Which session's harness to ask about its MCP servers. */
export type ListMcpServersInput = {
  /** Directory the session runs in; project configuration is read from it. */
  cwd: string;
  providerAccountId?: string;
  /** Ask the harness again instead of answering from a recent result. */
  refresh?: boolean;
};

/** One MCP server as a harness's own CLI reports it. */
export type HarnessMcpServer = {
  name: string;
  /** False when the harness's configuration switches the server off. */
  enabled: boolean;
  /** Program a stdio server runs. */
  command?: string;
  /** Its arguments, for a locality decision (`mcp-remote <url>`). */
  args?: string[];
  /** Address of an HTTP server. */
  url?: string;
};
