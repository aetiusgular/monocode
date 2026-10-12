/**
 * #45: sessions a harness keeps for a folder, outside MonoCode, that a chat
 * can pick up and continue. Claude Code lists them from its transcript files,
 * Codex from `thread/list`.
 */

/** One session the harness knows for the folder. */
export type HarnessSessionRow = {
  /** The harness's own id: a Claude Code session id or a Codex thread id. */
  id: string;
  /** First prompt or the harness's title, one line, plain text. */
  title: string;
  /** Epoch ms of the last change the harness recorded. */
  updatedAt: number;
  /** Short facts for the row, such as the model provider it was recorded with. */
  detail?: string;
};

export type ListSessionsInput = {
  /** The folder the chat runs in: its worktree when it has one. */
  cwd: string;
  /** The account the chat runs as, so the list comes from that account's home. */
  providerAccountId?: string;
};

export type ReadSessionInput = ListSessionsInput & {
  providerSessionId: string;
};

/** One earlier turn, as plain text. */
export type ImportedTurn = {
  /** The harness's own turn id, kept so rewind and fork work on it later. */
  providerTurnId?: string;
  user: string;
  assistant?: string;
  /** Epoch ms when the turn started, when known. */
  startedAt?: number;
};

export type ImportedHistory = {
  turns: ImportedTurn[];
  /** Older turns or text were left out to stay under the limits. */
  truncated: boolean;
};
