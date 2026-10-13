import { invoke } from "@tauri-apps/api/core";

export type CheckpointFile = {
  path: string;
  relative: string;
  status: string;
  additions: number;
  deletions: number;
  /** True when an exact recorded before/after diff is available. */
  exact: boolean;
  /** False when restoring could overwrite a change made outside this session. */
  undoable: boolean;
};

export type CheckpointStatus = {
  files: CheckpointFile[];
};

export type CheckpointFileDiff = {
  path: string;
  relative: string;
  status: string;
  original: string;
  current: string;
  binary: boolean;
  tooLarge: boolean;
};

export type CheckpointApplyResult = {
  files: string[];
  alreadyApplied: number;
};

const REVIEW_CHANGED = "monocode-review-changed";
const checkpointQueues = new Map<string, Promise<void>>();
const activeTurns = new Map<string, { id: string; cwd: string }>();

function enqueueCheckpoint<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = checkpointQueues.get(sessionId) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  checkpointQueues.set(sessionId, tail);
  void tail.then(() => {
    if (checkpointQueues.get(sessionId) === tail) {
      checkpointQueues.delete(sessionId);
    }
  });
  return result;
}

/** Wait until every queued checkpoint write for this session is durable. */
export function flushSessionCheckpoint(sessionId: string): Promise<void> {
  return checkpointQueues.get(sessionId) ?? Promise.resolve();
}

export function notifyReviewChanged(sessionId?: string) {
  window.dispatchEvent(
    new CustomEvent(REVIEW_CHANGED, { detail: sessionId ?? "" }),
  );
}

export function subscribeReviewChanged(
  listener: (sessionId: string) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<string>).detail ?? "");
  };
  window.addEventListener(REVIEW_CHANGED, handler);
  return () => window.removeEventListener(REVIEW_CHANGED, handler);
}

export function ensureSessionCheckpoint(
  sessionId: string,
  cwd: string,
): Promise<void> {
  return enqueueCheckpoint(sessionId, () =>
    invoke<void>("session_checkpoint_ensure", { sessionId, cwd }),
  );
}

/** Why the backend took no checkpoint on purpose. */
export type CheckpointSkipped = {
  reason: "homeRepository" | "unresolvedRepository" | (string & {});
  repository: string;
};

/** The chat notice for a skipped checkpoint. */
export function checkpointSkippedNotice(skip: CheckpointSkipped): string {
  if (skip.reason === "unresolvedRepository") {
    return `No checkpoint for this turn: the repository top folder for ${skip.repository} could not be found, so it may cover your home folder.`;
  }
  return `No checkpoint for this turn: the repository at ${skip.repository} covers your home folder.`;
}

/** Chats already told, so the notice shows once per chat and repository. */
const skipNoticesShown = new Set<string>();

/** Record the workspace before execution, including existing uncommitted files. */
export async function beginSessionTurn(
  sessionId: string,
  cwd: string,
  editedPaths?: readonly string[],
  onSkipped?: (notice: string) => void,
): Promise<string | undefined> {
  if (!cwd || cwd === "~") return undefined;
  const id = crypto.randomUUID();
  activeTurns.set(sessionId, { id, cwd });
  // Capture errors are also persisted by the backend and shown in the review.
  const skipped = await enqueueCheckpoint(sessionId, () =>
    invoke<CheckpointSkipped | null | undefined>(
      "session_checkpoint_begin_turn",
      {
        sessionId,
        cwd,
        turnId: id,
        ...(editedPaths === undefined ? {} : { editedPaths }),
      },
    ),
  ).catch((error: unknown) => {
    console.error(error);
    return undefined;
  });
  if (skipped) {
    // No git ran, so there is no turn to finish or rewind to.
    if (activeTurns.get(sessionId)?.id === id) activeTurns.delete(sessionId);
    const key = JSON.stringify([sessionId, skipped.repository]);
    if (!skipNoticesShown.has(key)) {
      skipNoticesShown.add(key);
      onSkipped?.(checkpointSkippedNotice(skipped));
    }
    return undefined;
  }
  notifyReviewChanged(sessionId);
  return id;
}

/** Capture the settled workspace before exposing the turn's recorded diff. */
export function finishSessionTurn(
  sessionId: string,
  cwd: string,
  options?: { turnId?: string; after?: Promise<unknown> },
): Promise<void> {
  const active = activeTurns.get(sessionId);
  const id = options?.turnId ?? (active?.cwd === cwd ? active.id : undefined);
  if (!id) return Promise.resolve();
  return enqueueCheckpoint(sessionId, async () => {
    // Cancellation must stop the provider before its final snapshot is taken.
    await options?.after;
    await invoke<void>("session_checkpoint_finish_turn", {
      sessionId,
      cwd,
      turnId: id,
    });
  })
    .catch(console.error)
    .finally(() => {
      if (activeTurns.get(sessionId)?.id === id) activeTurns.delete(sessionId);
      notifyReviewChanged(sessionId);
    });
}

/** Capture a file immediately before a structured edit starts. */
export function prepareSessionCheckpoint(
  sessionId: string,
  cwd: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return Promise.resolve();
  return enqueueCheckpoint(sessionId, () =>
    invoke<void>("session_checkpoint_prepare", {
      sessionId,
      cwd,
      paths,
    }),
  );
}

export function captureSessionCheckpoint(
  sessionId: string,
  cwd: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return Promise.resolve();
  return enqueueCheckpoint(sessionId, () =>
    invoke<void>("session_checkpoint_capture", {
      sessionId,
      cwd,
      paths,
    }),
  );
}

export function sessionCheckpointStatus(
  sessionId: string,
  cwd: string,
  editedPaths?: readonly string[],
): Promise<CheckpointStatus> {
  return enqueueCheckpoint(sessionId, () =>
    invoke<CheckpointStatus>("session_checkpoint_status", {
      sessionId,
      cwd,
      ...(editedPaths === undefined ? {} : { editedPaths }),
    }),
  );
}

/** Apply one isolated worker's captured delta to its lead checkout. */
export function applySessionCheckpoint(
  sessionId: string,
  fromCwd: string,
  toCwd: string,
): Promise<CheckpointApplyResult> {
  return enqueueCheckpoint(sessionId, () =>
    invoke<CheckpointApplyResult>("session_checkpoint_apply", {
      sessionId,
      fromCwd,
      toCwd,
    }),
  );
}

/** True only when the checkout still matches its seeded, pre-worker state. */
export function sessionCheckpointCleanupSafe(
  sessionId: string,
  cwd: string,
): Promise<boolean> {
  return enqueueCheckpoint(sessionId, () =>
    invoke<boolean>("session_checkpoint_cleanup_safe", { sessionId, cwd }),
  );
}

export function forgetSessionCheckpoint(sessionId: string): Promise<void> {
  const activeId = activeTurns.get(sessionId)?.id;
  return enqueueCheckpoint(sessionId, () =>
    invoke<void>("session_checkpoint_forget", { sessionId }),
  ).then(() => {
    if (activeTurns.get(sessionId)?.id === activeId)
      activeTurns.delete(sessionId);
  });
}

/** The before/after contents saved in the session's recorded checkpoint. */
export function sessionCheckpointFileDiff(
  sessionId: string,
  cwd: string,
  relative: string,
): Promise<CheckpointFileDiff> {
  return enqueueCheckpoint(sessionId, () =>
    invoke<CheckpointFileDiff>("session_checkpoint_file_diff", {
      sessionId,
      cwd,
      relative,
    }),
  );
}

export function undoSessionChanges(
  sessionId: string,
  cwd: string,
  relative?: string,
): Promise<CheckpointStatus> {
  return enqueueCheckpoint(sessionId, () =>
    invoke<CheckpointStatus>("session_checkpoint_undo", {
      sessionId,
      cwd,
      relative: relative ?? null,
    }),
  );
}

export function keepSessionChanges(
  sessionId: string,
  cwd: string,
  relative?: string,
): Promise<CheckpointStatus> {
  return enqueueCheckpoint(sessionId, () =>
    invoke<CheckpointStatus>("session_checkpoint_keep", {
      sessionId,
      cwd,
      relative: relative ?? null,
    }),
  );
}

/** One file a restore to before an earlier turn would change. */
export type RestoreFile = {
  path: string;
  relative: string;
  action: "restore" | "recreate" | "delete";
  restorable: boolean;
  reason?: string | null;
};

export type RestorePreview = {
  turnId: string;
  files: RestoreFile[];
  /** Why the restore cannot run now, when it cannot. */
  blocked?: string | null;
};

export type RestoreResult = {
  restored: string[];
  skipped: string[];
  /** A commit of the folder just before the restore, to undo it by hand. */
  backup: string;
  backupRef: string;
};

/** What putting files back to before `turnId` would change. Read only. */
export function previewRestoreSessionTurn(
  sessionId: string,
  cwd: string,
  turnId: string,
): Promise<RestorePreview> {
  return enqueueCheckpoint(sessionId, () =>
    invoke<RestorePreview>("session_checkpoint_restore_preview", {
      sessionId,
      cwd,
      turnId,
    }),
  );
}

/**
 * Puts every file back to how it was before `turnId`, after a backup commit
 * of the folder as it is now. Refused while a turn runs in this folder, in
 * this chat or another, and when the branch moved since that turn.
 */
export async function restoreSessionTurn(
  sessionId: string,
  cwd: string,
  turnId: string,
): Promise<RestoreResult> {
  const result = await enqueueCheckpoint(sessionId, () =>
    invoke<RestoreResult>("session_checkpoint_restore_turn", {
      sessionId,
      cwd,
      turnId,
    }),
  );
  notifyReviewChanged(sessionId);
  return result;
}
