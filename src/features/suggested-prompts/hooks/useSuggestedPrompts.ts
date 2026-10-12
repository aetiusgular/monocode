import { useEffect, useMemo, useState } from "react";
import { gitDiffStats } from "../../../platform/tauri/fs";
import { looksLikeProject } from "../../projects/model/recents";
import type { Block } from "../../sessions/model/session";
import {
  dismissSuggestions,
  suggestPrompts,
  suggestionsDismissed,
  type ProjectState,
  type SuggestedPrompt,
} from "../model/suggestions";

/**
 * The chips for one session (#46). The only outside read is a local
 * `git diff --stat` on the working folder, taken when the chat opens and
 * after each turn ends. No network call and no model call.
 */
export function useSuggestedPrompts(input: {
  sessionId: string;
  workCwd: string;
  blocks: readonly Block[];
  busy: boolean;
  remote: boolean;
}): {
  prompts: SuggestedPrompt[];
  dismiss: () => void;
} {
  const { sessionId, workCwd, blocks, busy, remote } = input;
  const [state, setState] = useState<ProjectState>({ changes: null });
  const [dismissed, setDismissed] = useState(() =>
    suggestionsDismissed(sessionId),
  );

  useEffect(() => {
    setDismissed(suggestionsDismissed(sessionId));
  }, [sessionId]);

  useEffect(() => {
    if (busy || remote || dismissed || !looksLikeProject(workCwd)) {
      setState({ changes: null });
      return;
    }
    let cancelled = false;
    // A short wait, so a turn's last file writes land before the read.
    const timer = window.setTimeout(() => {
      void gitDiffStats(workCwd).then(
        (changes) => {
          if (!cancelled) setState({ changes });
        },
        // Not a repository, or git is missing: no chip for changes.
        () => {
          if (!cancelled) setState({ changes: null });
        },
      );
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [busy, dismissed, remote, sessionId, workCwd]);

  const prompts = useMemo(
    () =>
      dismissed ? [] : suggestPrompts({ blocks, busy, hasDraft: false, state }),
    [blocks, busy, dismissed, state],
  );
  return {
    prompts,
    dismiss: () => {
      dismissSuggestions(sessionId);
      setDismissed(true);
    },
  };
}
