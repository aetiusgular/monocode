/**
 * How Claude Code loads connector tool definitions, set through the
 * `ENABLE_TOOL_SEARCH` variable in the `--settings` env MonoCode already
 * passes. Read in Claude Code 2.1.292 (12 Oct 2026): unset defers tool
 * definitions behind a search tool, `auto` defers them only when they are
 * large, and a false value loads every definition up front.
 *
 * Session 9 ran it on 2.1.292 and 2.1.296 with a base URL that is not
 * Anthropic's: unset and "false" sent all 29 tools, and "true" sent 13 and a
 * search tool. Deferral covers Claude Code's built-in tools too, not only
 * connectors. Through Anthropic's own API the default is not seen yet.
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
    note: "Claude Code decides. On Anthropic's API it can hold tool definitions back, its own tools included, until the model searches for them.",
  },
  {
    value: "auto",
    label: "Automatic",
    note: "Claude Code sends definitions up front when they are small and holds them back, its own tools included, when they are large.",
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
