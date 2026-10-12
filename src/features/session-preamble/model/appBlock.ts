/**
 * The `<monocode_app>` block that tells an agent it may use MonoCode's app
 * CLI (F7). It names the action groups that matter in this thread and points
 * at `app help <action>`, which returns one action's fields in a few hundred
 * characters. The whole usage text is about 10,000 characters, a fifth of
 * what a 16k local model has left after Codex's opening request.
 */

export type AppBlockInput = {
  /** The app CLI, already quoted for the agent's shell, ending in ` app`. */
  cli: string;
  /** App access is part of the thread (a Mono), not switched on by /operator. */
  alwaysEnabled: boolean;
  /** Project memory actions are available to this thread (#36). */
  memory?: boolean;
};

/** Action groups a regular /operator thread uses, in the order they matter. */
export const OPERATOR_GROUPS = [
  "sessions",
  "worktrees",
  "folders",
  "notes",
] as const;

export function appBlock({
  cli,
  alwaysEnabled,
  memory,
}: AppBlockInput): string {
  const groups: string[] = [...OPERATOR_GROUPS];
  if (memory) groups.push("memory");
  const access = alwaysEnabled
    ? "App access is always enabled in this thread."
    : "The user's Operator command enables app access in this thread, including later turns without the command.";
  const lines = [
    `${access} Through MonoCode's local CLI you can start session tabs or split session panes right or down, list and create project worktrees, choose a new session's checkout, read, continue, stop, archive or delete other project sessions, save unsent drafts, organize session folders, and read or write saved notes.${memory ? " You can also read, search and propose entries in this project's memory; an entry you add waits for the user's approval." : ""}`,
    `Action groups: ${groups.join(", ")}. Run \`${cli} help <action>\` (for example \`${cli} help sessions.start\`) or \`${cli} help <group>\` for the exact JSON fields of what you are about to call. \`${cli} --help\` prints everything and is long.`,
    "When reading another session, start with its latest two or three user/assistant exchanges. Request older exchanges with nextBefore or a larger excerpt only if needed.",
    "The CLI uses a session credential already in your environment; never print it.",
    "New sessions inherit this session's permission mode unless runtimeMode is set explicitly. For a new session with a draft, call sessions.start with its prompt and draft:true; do not submit a seed prompt. The returned ID can be used as besideSessionId to split its pane again or moved into a folder immediately. A normal sessions.start submits its prompt but returns after acceptance, so do not wait for that agent to finish before organizing it.",
  ];
  return `<monocode_app>\n${lines.join(" ")}\n</monocode_app>`;
}
