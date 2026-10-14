import { useEffect, useState } from "react";
import type { Session } from "../../sessions/model/session";
import { subscribeProjectContext } from "../../project-context/model/projectContext";
import { useChatContextVersion } from "../model/chatContext";
import { instructionsStaleNow } from "../model/sessionPreamble";

/** Finding 2.2: the line an open chat shows when its instructions changed. */
export const STALE_INSTRUCTIONS_TEXT =
  "Your instructions changed after this chat started. They apply to new chats.";
export const NEW_CHAT_WITH_THESE = "New chat with these";

export function StaleInstructionsView({
  onNewChat,
  className = "",
}: {
  /** Absent when the app has no way to open one here: the button is left out. */
  onNewChat?: () => void;
  className?: string;
}) {
  return (
    <div
      data-instructions-stale
      role="status"
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-content/70 ${className}`}
    >
      <span>{STALE_INSTRUCTIONS_TEXT}</span>
      {onNewChat ? (
        <button
          type="button"
          data-instructions-new-chat
          className="rounded-md px-2 py-0.5 text-content/85 hover:bg-content/8 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          onClick={onNewChat}
        >
          {NEW_CHAT_WITH_THESE}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Whether this chat's instructions or project notes changed after its
 * provider conversation started. Checked again when either is saved and
 * after each turn's receipt.
 */
export function useInstructionsStale(
  session: Pick<Session, "id" | "providerSessionId"> | undefined,
  project: string | undefined,
): boolean {
  const version = useChatContextVersion();
  const [stale, setStale] = useState(false);
  const [saved, setSaved] = useState(0);
  useEffect(() => subscribeProjectContext(() => setSaved((n) => n + 1)), []);
  const id = session?.id;
  const provider = session?.providerSessionId;
  useEffect(() => {
    let live = true;
    if (!id || !provider) {
      setStale(false);
      return;
    }
    void instructionsStaleNow({ id, providerSessionId: provider }, project)
      .then((next) => live && setStale(next))
      .catch(() => live && setStale(false));
    return () => {
      live = false;
    };
  }, [id, provider, project, version, saved]);
  return stale;
}

/** Above the composer in the session pane. Nothing unless stale. */
export function StaleInstructionsLine({
  session,
  project,
  onNewChat,
}: {
  session: Pick<Session, "id" | "providerSessionId">;
  project: string | undefined;
  onNewChat?: () => void;
}) {
  const stale = useInstructionsStale(session, project);
  if (!stale) return null;
  return (
    <StaleInstructionsView
      onNewChat={onNewChat}
      className="mx-auto w-full max-w-4xl px-3 pb-1"
    />
  );
}
