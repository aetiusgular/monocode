import { useCallback, useEffect, useRef, useState } from "react";
import {
  getComposerDraft,
  setComposerDraft,
} from "../../sessions/model/draftCache";
import {
  lastUserTurnBlock,
  type LastTurnRecall,
} from "../../sessions/model/editLastTurn";
import type {
  Attachment,
  ComposerTurnOptions,
  Session,
} from "../../sessions/model/session";

type Options = {
  session: Session;
  /**
   * The last prompt as edit and resend would recall it, or null where the
   * session cannot take its last turn back. Retry is offered exactly where
   * this is present.
   */
  recall: LastTurnRecall | null;
  /** The pane's own submit: the path an edited prompt is resent through. */
  submit: (
    text: string,
    attachments: Attachment[],
    options: ComposerTurnOptions,
  ) => boolean | void;
  /**
   * Puts a prompt back in the composer. Called when the harness had already
   * dropped the turn and then did not take the prompt, so it is not lost.
   */
  restorePrompt?: (text: string, attachments: Attachment[]) => void;
};

export type RetryLastTurn = {
  /** Sends the last prompt again in place of its turn. Undefined where it cannot be. */
  retry: (() => void) | undefined;
  /** The resend in flight was started by `retry`, not by an edit. */
  retrying: boolean;
};

/**
 * Retry under the last reply. It is edit and resend with the prompt left as
 * it was: the harness takes the last turn back, then gets the same text and
 * files, in the mode the turn was sent in. There is no second rewind path.
 */
export function useRetryLastTurn({
  session,
  recall,
  submit,
  restorePrompt,
}: Options): RetryLastTurn {
  // The prompt a retry was started for. It stops matching once that prompt
  // is replaced, so nothing has to clear it when the resend goes through.
  const [retriedBlockId, setRetriedBlockId] = useState<string | null>(null);
  const block = lastUserTurnBlock(session.blocks);
  const blockId = block?.id;
  const intent = block?.intent;
  const sessionId = session.id;
  // The session this pane has on show, and so whose composer is mounted.
  const shown = useRef<string | null>(null);
  useEffect(() => {
    shown.current = sessionId;
    return () => {
      shown.current = null;
    };
  }, [sessionId]);

  const retry = useCallback(() => {
    if (!recall || !blockId) return;
    let rejected = false;
    const accepted = submit(recall.text, recall.attachments, {
      intent: intent ?? "default",
      resendEdited: true,
      onResendRejected: ({ providerRewound }) => {
        rejected = true;
        setRetriedBlockId((current) => (current === blockId ? null : current));
        // Until the harness drops the turn it stays in the chat, and Retry
        // with it. After that the prompt is only left here to hand back.
        if (!providerRewound) return;
        if (shown.current === sessionId) {
          restorePrompt?.(recall.text, recall.attachments);
        } else if (!getComposerDraft(sessionId)) {
          // The pane has moved on. The text waits as that session's draft;
          // the draft cache holds no files, so those are not kept.
          setComposerDraft(sessionId, recall.text);
        }
      },
    });
    if (accepted !== false && !rejected) setRetriedBlockId(blockId);
  }, [blockId, intent, recall, restorePrompt, sessionId, submit]);

  return {
    retry: recall && blockId ? retry : undefined,
    retrying:
      !!session.resendingEdited &&
      retriedBlockId != null &&
      retriedBlockId === blockId,
  };
}
