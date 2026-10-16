import type { Block, Session } from "./session";

/** Shown when a turn finished and nothing at all came back from the model. */
export const EMPTY_TURN_NOTICE =
  "The model finished this turn without a reply. Nothing came back from it, so there is nothing to show. Try again, or try another model.";

/**
 * Shown when a turn finished after tool steps with no reply after the last
 * one (Mac finding 3.7, retest 3). Codex 0.161.0 takes `last_agent_message`
 * only from the turn's last model request, so a last step that was only
 * reasoning completes with `None` and `turn/completed` carries no items
 * (codex-rs `core/src/session/turn.rs`, app-server `thread_state.rs`;
 * openai/codex #32267 on Ollama). Codex's own interface shows nothing.
 */
export function stoppedAfterStepsNotice(steps: number): string {
  const count = steps === 1 ? "1 step" : `${steps} steps`;
  return `The agent ran ${count}, then stopped without a reply. Ask it to continue, or try another model.`;
}

/**
 * A block that shows something the model or agent produced for the user.
 * Reasoning alone is not a reply: Codex can end a turn with only a reasoning
 * item and `last_agent_message: None` (Mac finding 3.7, retest).
 */
function isOutput(block: Block): boolean {
  if (block.role === "system" || block.role === "reasoning") return false;
  if (block.role === "assistant") {
    return block.text.trim().length > 0 || !!block.image;
  }
  return true;
}

/** A tool call or an approval card: one step the agent took. */
function isStep(block: Block): boolean {
  return block.role === "tool" || block.role === "approval";
}

/**
 * A reply the user can read after the agent's steps: assistant text or an
 * image, a plan, a handoff. Reasoning, status lines and task-list updates are
 * not; they say what the agent was doing, not what it found. Roo Code, Cline
 * and OpenHands treat a reasoning-only end the same way.
 */
function isReply(block: Block): boolean {
  switch (block.role) {
    case "assistant":
      return block.text.trim().length > 0 || !!block.image;
    case "image":
    case "plan":
    case "handoff":
      return true;
    case "system":
    case "reasoning":
    case "tasks":
    case "tool":
    case "approval":
      return false;
    case "user":
      // Only an app-written turn can follow the last prompt; it moves the
      // conversation on, so the turn is not left hanging.
      return true;
    default:
      return false;
  }
}

function noticeBlock(text: string): Block {
  return {
    id: crypto.randomUUID(),
    role: "system",
    text,
    notice: "error",
  };
}

/**
 * Adds a notice when the last turn finished without a reply.
 *
 * - Nothing after the prompt: `EMPTY_TURN_NOTICE`. On a small local model
 *   Codex can drop what the model wrote (`last_agent_message: null`), and the
 *   chat showed an empty finished turn with no word of why (Mac finding 3.7,
 *   corner case 2).
 * - Tool steps and no reply after the last one: `stoppedAfterStepsNotice`.
 *
 * Only a completed turn gets either; a stopped or failed one says so already.
 * No retry and no button: the user decides what to send next.
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
  // An error or an interruption already says what happened.
  if (after.some((block) => block.notice)) return session;
  if (!after.some(isOutput)) {
    return { ...session, blocks: [...blocks, noticeBlock(EMPTY_TURN_NOTICE)] };
  }
  let lastStep = -1;
  for (let i = after.length - 1; i >= 0; i -= 1) {
    if (isStep(after[i])) {
      lastStep = i;
      break;
    }
  }
  if (lastStep < 0) return session;
  if (after.slice(lastStep + 1).some(isReply)) return session;
  const steps = after.filter(isStep).length;
  return {
    ...session,
    blocks: [...blocks, noticeBlock(stoppedAfterStepsNotice(steps))],
  };
}
