import type { HarnessId } from "../../../features/sessions/model/session";

/**
 * What each harness can do, in one table. The UI asks this table, never the
 * harness id, when a feature differs between harnesses.
 *
 * Two kinds of entry:
 *
 * - What MonoCode drives today (attachments, extra folders, connector and
 *   skill switches, tool access, research, plugins, edit and resend, steer,
 *   compact, text prompts). These match the adapters and the old literal
 *   checks one for one, so reading the table changes no behaviour.
 * - The native upgrade a feature may use where the harness offers one
 *   (instructions, rewind at any turn, fork, background list and stop,
 *   session list). These are set for Claude Code and Codex only, the two
 *   harnesses whose upgrades are built now. Every other harness gets the
 *   baseline: MonoCode does the work and the model reads or writes text.
 *
 * A harness with no record below gets `BASELINE`, so a harness added
 * upstream gets every baseline feature and no native upgrade.
 */

/** Where MonoCode can put its own instructions natively. */
export type InstructionsChannel =
  /** A system prompt at launch, such as Claude Code's append flag. */
  | "system"
  /** A field on session or thread start, such as Codex's developer instructions. */
  | "session"
  /** A field on every prompt. */
  | "turn"
  /** None: a marked block ahead of the next user message. */
  | "none";

/** How far back the chat can be rewound natively. */
export type RewindReach = "anyTurn" | "lastTurn" | "none";

/** Native fork of a conversation. */
export type ForkReach = "atTurn" | "whole" | "none";

/** How MonoCode can list the harness's own sessions for a folder. */
export type SessionListing = "native" | "files" | "none";

/** How environment values reach the harness and its tools. */
export type EnvDelivery =
  /** The harness is a child process and inherits what it is given. */
  | "inherit"
  /** A shared service: values need a per-session call that is not built. */
  | "service";

export type HarnessCapabilities = {
  instructions: InstructionsChannel;
  rewind: RewindReach;
  fork: ForkReach;
  backgroundList: boolean;
  backgroundStop: boolean;
  /** MonoCode passes MCP servers at session start. */
  mcpInject: boolean;
  listSessions: SessionListing;
  env: EnvDelivery;
  /** Approval requests name a tool MonoCode can keep a rule for. */
  namedApprovals: boolean;
  /** The harness can suggest the next prompt itself. Not checked in the app. */
  promptSuggestions: boolean;
  /** The harness runs commands in its own sandbox. */
  sandboxed: boolean;
  /** MonoCode can steer a running turn. */
  steer: boolean;
  /** MonoCode can ask the harness to compact its context. */
  compact: boolean;
  /** MonoCode can run an isolated text prompt, for titles and helpers. */
  textPrompt: boolean;
  /** Prompts may carry file and image attachments. */
  attachments: boolean;
  /** Extra working folders can be handed to the harness. */
  extraDirs: boolean;
  /** One MCP server can be left out of a single conversation. */
  connectorSwitches: boolean;
  /** MonoCode expands `/name` skills itself, so one chat can leave one out. */
  skillSwitches: boolean;
  /** Research mode wraps the prompt. */
  research: boolean;
  /** Per-chat plugin switches. */
  pluginSwitches: boolean;
};

/** What a harness with no record gets: every baseline, no native upgrade. */
export const BASELINE: HarnessCapabilities = {
  instructions: "none",
  rewind: "none",
  fork: "none",
  backgroundList: false,
  backgroundStop: false,
  mcpInject: false,
  listSessions: "none",
  env: "inherit",
  namedApprovals: false,
  promptSuggestions: false,
  sandboxed: false,
  steer: true,
  compact: false,
  textPrompt: false,
  attachments: true,
  extraDirs: false,
  connectorSwitches: false,
  skillSwitches: true,
  research: false,
  pluginSwitches: false,
};

const CAPABILITIES: Record<HarnessId, HarnessCapabilities> = {
  claude: {
    ...BASELINE,
    // `--append-system-prompt` at launch. Check 2 (step 3c, section 13) has
    // not run in MonoCode's spawn shape; set "none" if it fails.
    instructions: "system",
    // `--resume-session-at` at any recorded entry. Boundaries are lost
    // across a compaction and after an app restart.
    rewind: "anyTurn",
    // `--fork-session` with `--resume`. Check 6 has not run.
    fork: "atTurn",
    backgroundList: true,
    backgroundStop: true,
    mcpInject: true,
    // Transcript files only. No documented CLI list.
    listSessions: "files",
    namedApprovals: true,
    // `--prompt-suggestions` is documented for `--print`, which MonoCode's
    // spawn does not pass. Not checked.
    promptSuggestions: true,
    compact: true,
    textPrompt: true,
    extraDirs: true,
    connectorSwitches: true,
    research: true,
    pluginSwitches: true,
  },
  codex: {
    ...BASELINE,
    // `developerInstructions` on `thread/start`. Check 3 has not run.
    instructions: "session",
    // `thread/revert`, paginated threads only. Check 4 decides whether the
    // local home has it; set "lastTurn" if it fails.
    rewind: "anyTurn",
    // `thread/fork` with `lastTurnId`. Check 5 has not run.
    fork: "atTurn",
    // `thread/backgroundTerminals/list` and `/terminate`, experimental.
    backgroundList: true,
    backgroundStop: true,
    mcpInject: true,
    listSessions: "native",
    namedApprovals: true,
    sandboxed: true,
    compact: true,
    textPrompt: true,
    extraDirs: true,
    connectorSwitches: true,
    research: true,
  },
  cursor: { ...BASELINE, textPrompt: true },
  grok: { ...BASELINE, steer: false, compact: true, textPrompt: true },
  opencode: {
    ...BASELINE,
    rewind: "lastTurn",
    env: "service",
    compact: true,
    textPrompt: true,
  },
  pi: {
    ...BASELINE,
    rewind: "lastTurn",
    compact: true,
    textPrompt: true,
    skillSwitches: false,
  },
  omp: {
    ...BASELINE,
    rewind: "lastTurn",
    compact: true,
    textPrompt: true,
    skillSwitches: false,
  },
  fx: { ...BASELINE, steer: false, attachments: false },
  hermes: { ...BASELINE },
  antigravity: { ...BASELINE, steer: false },
  // Devin runs its own `/name` commands, like Pi and omp, so MonoCode cannot
  // hold a skill back. The literal check missed Devin after the v0.12.0 merge.
  devin: {
    ...BASELINE,
    steer: false,
    compact: true,
    textPrompt: true,
    skillSwitches: false,
  },
};

/** The capability record for a harness. Unknown ids get the baseline. */
export function harnessCapabilities(id: HarnessId): HarnessCapabilities {
  return CAPABILITIES[id] ?? BASELINE;
}

/** One capability of one harness. */
export function harnessCan<K extends keyof HarnessCapabilities>(
  id: HarnessId,
  key: K,
): HarnessCapabilities[K] {
  return harnessCapabilities(id)[key];
}
