import { useEffect, useRef } from "react";
import { forgetPreview } from "../../app-preview/model/previewStore";
import {
  cancelAutoSend,
  noteAutoSend,
  noteTurnEnd,
  noteTurnStart,
  turnEdges,
  type VerifyTurnSession,
} from "./verifyStore";

/**
 * #38a in the app: watch every chat's busy edge, verify after turns that
 * changed files, and send a failure by itself when the chat's auto switch is
 * on. Also stops a chat's preview when the chat is deleted.
 *
 * `submit` sends text as the user's next message and says whether it went.
 */
export function useVerifyAfterTurns(
  sessions: readonly VerifyTurnSession[],
  submit: (sessionId: string, text: string) => boolean,
): void {
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    const { started, ended, gone } = turnEdges(sessions);
    for (const session of started) noteTurnStart(session);
    for (const id of gone) void forgetPreview(id);
    for (const session of ended) {
      void noteTurnEnd(session)
        .then((outcome) => {
          if (!outcome?.autoSend) return;
          noteAutoSend(session.id);
          if (!submitRef.current(session.id, outcome.result.report))
            cancelAutoSend(session.id);
        })
        .catch(() => undefined);
    }
  }, [sessions]);
}
