/**
 * #45: Claude Code sessions recorded for a folder. Read by the app from the
 * account's transcript files (`claude_sessions_list`), because Claude Code
 * documents no command that lists them. Their old turns are not imported:
 * the file format changes between versions. A picked-up chat resumes the
 * session by id, and the agent has the whole conversation.
 */
import { invoke } from "@tauri-apps/api/core";
import { sanitizeSessionRows } from "../../../../features/session-import/model/sessionImport";
import type {
  HarnessSessionRow,
  ListSessionsInput,
} from "../../../../features/session-import/model/types";

export async function listClaudeSessions(
  input: ListSessionsInput,
): Promise<HarnessSessionRow[]> {
  let rows: unknown;
  try {
    rows = await invoke<unknown>("claude_sessions_list", {
      cwd: input.cwd,
      accountId:
        input.providerAccountId && input.providerAccountId !== "default"
          ? input.providerAccountId
          : null,
    });
  } catch (error) {
    // Tauri rejects with the command's message as a plain string.
    throw error instanceof Error ? error : new Error(String(error));
  }
  return sanitizeSessionRows(rows);
}
