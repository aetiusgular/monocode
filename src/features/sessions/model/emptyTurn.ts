import type { Block, Session } from "./session";

/** Shown when a turn finished and nothing at all came back from the model. */
export const EMPTY_TURN_NOTICE =
  "The model finished this turn without a reply. Nothing came back from it, so there is nothing to show. Try again, or try another model.";

/** A block that shows something the model or agent produced. */
function isOutput(block: Block): boolean {
  if (block.role === "system") return false;
  if (block.role === "assistant" || block.role === "reasoning") {
    return block.text.trim().length > 0 || !!block.image;
  }
  return true;
}

/**
 * Adds a notice when the last turn ended with nothing after the prompt.
 *
 * On a small local model Codex can drop what the model wrote
 * (`last_agent_message: null`), and the chat showed an empty finished turn
 * with no word of why (Mac finding 3.7, corner case 2). Only a completed turn
 * gets this; a stopped or failed one says so already.
 */
export function withEmptyTurnNotice(session: Session): Session {
  const blocks = session.blocks;
  let lastUser = -1;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].role === "user" && !blocks[i].internal) {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return session;
  const after = blocks.slice(lastUser + 1);
  if (after.some(isOutput)) return session;
  // An error or an interruption already says what happened.
  if (after.some((block) => block.notice)) return session;
  return {
    ...session,
    blocks: [
      ...blocks,
      {
        id: crypto.randomUUID(),
        role: "system",
        text: EMPTY_TURN_NOTICE,
        notice: "error",
      },
    ],
  };
}
