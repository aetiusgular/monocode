/**
 * How Claude Code loads connector tool definitions, set through the
 * `ENABLE_TOOL_SEARCH` variable in the `--settings` env MonoCode already
 * passes. Read in Claude Code 2.1.292 (12 Oct 2026): unset defers MCP tool
 * definitions behind a search tool, `auto` defers them only when they are
 * large, and a false value loads every definition up front.
 *
 * Claude Code only. No other harness has a known equivalent; there the lever
 * is fewer tools: the per-tool switches on each connector and the per-chat
 * connector switches.
 */

/** `default` leaves the variable alone, so your own settings decide. */
export type ToolLoading = "default" | "auto" | "upfront";

const KEY = "monocode.claudeToolLoading.v1";

export const TOOL_LOADING_CHOICES: {
  value: ToolLoading;
  label: string;
  note: string;
}[] = [
  {
    value: "default",
    label: "On demand (Claude Code's default)",
    note: "Tool definitions load when the model searches for them. Least context used.",
  },
  {
    value: "auto",
    label: "Automatic",
    note: "Claude Code loads them up front when they are small and on demand when they are large.",
  },
  {
    value: "upfront",
    label: "All up front",
    note: "Every definition is sent with every request. Uses the most context.",
  },
];

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The saved choice. Anything unreadable counts as `default`. */
export function readToolLoading(): ToolLoading {
  try {
    const value = storage()?.getItem(KEY);
    return value === "auto" || value === "upfront" ? value : "default";
  } catch {
    return "default";
  }
}

export function saveToolLoading(value: ToolLoading): void {
  try {
    if (value === "default") storage()?.removeItem(KEY);
    else storage()?.setItem(KEY, value);
  } catch {
    // Not saved; the choice lasts until the page reloads.
  }
}

/**
 * What a Claude Code launch passes on, or undefined to leave the variable
 * alone. A change gives new sessions a fresh process.
 */
export function loadClaudeToolLoading(): "auto" | "upfront" | undefined {
  const value = readToolLoading();
  return value === "default" ? undefined : value;
}
