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
