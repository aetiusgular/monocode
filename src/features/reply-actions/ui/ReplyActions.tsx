import { useEffect, useMemo } from "react";
import { RefreshCw, Square, Volume2 } from "../../../shared/ui/icons";
import type { Block } from "../../sessions/model/session";
import {
  speak,
  speechAvailable,
  stopSpeaking,
  useSpeaking,
} from "../model/speaker";
import {
  replySpeechSource,
  speechChunks,
  speechText,
} from "../model/speechText";

// The copy button's size and tone, so the row reads as one set.
const ACTION_BUTTON =
  "rounded-md p-1 outline-none hover:bg-content/8 hover:text-content/70 focus-visible:ring-1 focus-visible:ring-accent";

type Props = {
  /** Names the reply to the speaker. Unique across sessions: the turn's id. */
  replyId: string;
  /** The turn's blocks. Only the reply's prose and a plan are read out. */
  blocks: readonly Block[];
  /** False while the transcript is hidden or parked, which ends the reading. */
  active?: boolean;
  /**
   * Sends the last prompt again in place of this reply. Present only under
   * the last reply of an idle session whose harness can take a turn back.
   */
  onRetry?: () => void;
};

/** What sits beside the copy button under a finished reply. */
export function ReplyActions({
  replyId,
  blocks,
  active = true,
  onRetry,
}: Props) {
  return (
    <>
      <ReadAloudButton replyId={replyId} blocks={blocks} active={active} />
      {onRetry ? <RetryButton onRetry={onRetry} /> : null}
    </>
  );
}

function ReadAloudButton({
  replyId,
  blocks,
  active,
}: {
  replyId: string;
  blocks: readonly Block[];
  active: boolean;
}) {
  const speaking = useSpeaking(replyId);
  const source = replySpeechSource(blocks);
  const text = useMemo(() => speechText(source), [source]);

  useEffect(() => {
    if (!active) stopSpeaking(replyId);
  }, [active, replyId]);
  // A reply that leaves the screen stops talking.
  useEffect(() => () => stopSpeaking(replyId), [replyId]);

  // No voice here, or nothing in the reply to say: no button.
  if (!text || !speechAvailable()) return null;
  const label = speaking ? "Stop reading" : "Read aloud";
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={speaking}
      data-read-aloud={speaking ? "speaking" : "idle"}
      onClick={(event) => {
        event.stopPropagation();
        if (speaking) stopSpeaking(replyId);
        else speak(replyId, speechChunks(text));
      }}
      className={`${ACTION_BUTTON} ${
        speaking ? "bg-content/8 text-content/70" : "text-content/40"
      }`}
    >
      {speaking ? (
        <Square className="size-3.5" strokeWidth={1.75} />
      ) : (
        <Volume2 className="size-3.5" strokeWidth={1.75} />
      )}
    </button>
  );
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <button
      type="button"
      title="Retry"
      aria-label="Retry"
      data-retry-last-turn
      onClick={(event) => {
        event.stopPropagation();
        onRetry();
      }}
      className={`${ACTION_BUTTON} text-content/40`}
    >
      <RefreshCw className="size-3.5" strokeWidth={1.75} />
    </button>
  );
}
