import { invoke } from "@tauri-apps/api/core";

/** What one `claude plugin` call printed. Both streams are bounded. */
export type ClaudePluginOutput = {
  stdout: string;
  stderr: string;
  success: boolean;
};

/**
 * Runs one `claude plugin` command through the app, with the `claude` binary
 * sessions use and as the given Claude Code account (its `CLAUDE_CONFIG_DIR`).
 * The app runs only a fixed set of argument shapes (see
 * `src-tauri/src/claude_plugin.rs` and the builders in `pluginCli.ts`). A list
 * that fails rejects. An enable or disable resolves either way, because its
 * `--json` result explains a failure on stdout.
 */
export function runClaudePlugin(
  args: readonly string[],
  options: { cwd?: string; accountId?: string } = {},
): Promise<ClaudePluginOutput> {
  return invoke<ClaudePluginOutput>("claude_plugin", {
    args: [...args],
    cwd: options.cwd ?? null,
    accountId: options.accountId ?? null,
  });
}
