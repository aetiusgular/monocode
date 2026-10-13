import { invoke } from "@tauri-apps/api/core";

/**
 * The last main-chain entry of a Claude Code conversation, read by the app
 * from the end of its transcript file (`claude_session_last_entry`). After an
 * app restart a resumed conversation has not streamed anything yet, so this
 * is the only way to know where its next prompt joins it (1.6). Undefined on
 * any failure: the prompt then simply cannot be taken back.
 */
export async function readClaudeLastEntry(input: {
  cwd: string;
  sessionId: string;
  providerAccountId?: string;
}): Promise<string | undefined> {
  try {
    const value = await invoke<unknown>("claude_session_last_entry", {
      cwd: input.cwd,
      sessionId: input.sessionId,
      accountId:
        input.providerAccountId && input.providerAccountId !== "default"
          ? input.providerAccountId
          : null,
    });
    return typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
