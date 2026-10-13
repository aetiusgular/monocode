import type { Attachment, Session } from "../../sessions/model/session";
import {
  blocksBeforeTurn,
  rewindOptions,
  rewoundPrompt,
  type RewindContext,
  type RewindOptions,
} from "./rewind";

/**
 * What the transcript needs to offer rewind, restore and fork on a prompt.
 * Built once per pane; `optionsFor` reads the session as it is now.
 */
export type TurnRewind = {
  sessionId: string;
  /** The folder the session works in, for the file checkpoint. */
  cwd: string;
  optionsFor(blockId: string): RewindOptions | null;
  onRewindChat(blockId: string): Promise<void>;
  onFork(blockId: string): Promise<void>;
};

/** The prompt a chat rewind took back, for the composer. Not saved. */
export type RewoundPrompt = {
  text: string;
  attachments: Attachment[];
  /** New per rewind, so the composer fills once. */
  nonce: string;
};

export function turnRewindFor(
  session: Session,
  context: RewindContext,
  cwd: string,
  actions: {
    onRewindChat?: (sessionId: string, blockId: string) => Promise<void>;
    onFork?: (sessionId: string, blockId: string) => Promise<void>;
  },
): TurnRewind {
  return {
    sessionId: session.id,
    cwd,
    optionsFor: (blockId) => {
      const options = rewindOptions(session, blockId, context);
      if (!options) return null;
      // An action the host did not wire is off, with a reason, not hidden.
      return {
        ...options,
        chat: actions.onRewindChat
          ? options.chat
          : { enabled: false, reason: "Not available here" },
        fork: actions.onFork
          ? options.fork
          : { ...options.fork, enabled: false, reason: "Not available here" },
      };
    },
    onRewindChat: (blockId) =>
      actions.onRewindChat?.(session.id, blockId) ?? Promise.resolve(),
    onFork: (blockId) =>
      actions.onFork?.(session.id, blockId) ?? Promise.resolve(),
  };
}

/** The session once its chat is rewound to before the turn at `options`. */
export function applyChatRewind(
  session: Session,
  options: RewindOptions,
  nonce: string = crypto.randomUUID(),
): Session {
  const prompt = rewoundPrompt(session, options.turnStart);
  return {
    ...session,
    blocks: blocksBeforeTurn(session, options.turnStart),
    rewoundPrompt: { ...prompt, nonce },
  };
}

/**
 * The chat list once `sessionId` is rewound to before the prompt `blockId`.
 * Options are recomputed on the list given, in case the chat moved since the
 * harness was asked. A chat whose prompt is already gone is left as it is, so
 * applying this to both the app's ref and React's state, which may lag it,
 * cuts once and fills the composer once (the same `nonce` on both).
 */
export function rewindChatInSessions(
  sessions: readonly Session[],
  sessionId: string,
  blockId: string,
  nonce: string,
): Session[] {
  return sessions.map((session) => {
    if (session.id !== sessionId) return session;
    const options = rewindOptions(session, blockId);
    if (!options) return session;
    return applyChatRewind(session, options, nonce);
  });
}

/**
 * Where the app keeps its chats: a ref that harness event flushes read and
 * rebuild state from, and React's state, which a render copies into the ref.
 */
export type ChatSessionStore = {
  /** Applies every harness event still queued, from the ref. */
  flushEvents: () => void;
  current: () => readonly Session[];
  replaceCurrent: (next: Session[]) => void;
  setState: (update: (prev: Session[]) => Session[]) => void;
};

/**
 * Cuts the transcript once the harness has forgotten (#34), in a way a
 * harness event flush cannot undo.
 *
 * A flush rebuilds the chat list from the ref and replaces React's state with
 * it. Claude Code restarts to forget, and the restart queues events
 * (`session.providerBound`, `session.started`). A cut made only through a
 * React updater is lost when that flush lands before React renders: the flush
 * sets the list it built from the uncut ref, after the updater. So the queued
 * events are applied first, then the cut is written to the ref and to state.
 */
export function cutChatTranscript(
  store: ChatSessionStore,
  sessionId: string,
  blockId: string,
  nonce: string = crypto.randomUUID(),
): void {
  store.flushEvents();
  const update = (list: readonly Session[]) =>
    rewindChatInSessions(list, sessionId, blockId, nonce);
  store.replaceCurrent(update(store.current()));
  store.setState((prev) => update(prev));
}

const taken = new Set<string>();

/**
 * True the first time a rewound prompt is seen, so the composer fills once
 * and a remount (a tab switch, a split) does not overwrite what was typed.
 */
export function takeRewoundPrompt(prompt: RewoundPrompt | undefined): boolean {
  if (!prompt || taken.has(prompt.nonce)) return false;
  taken.add(prompt.nonce);
  if (taken.size > 200) taken.delete(taken.values().next().value as string);
  return true;
}
