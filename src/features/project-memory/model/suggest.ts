import {
  canRunHarnessTextPrompt,
  runHarnessTextPrompt,
} from "../../../integrations/harness/core/registry";
import {
  modelBudgetWindow,
  modelTimeoutFactor,
} from "../../model-traits/model/modelTraits";
import { MEMORY_ENTRY_MAX } from "../../monos/model/monoMemory";
import { nativeModelId } from "../../sessions/model/models";
import {
  isLocal,
  sessionIsLocal,
  type LocalitySession,
} from "../../server-locality/model/locality";
import type { Block, Session } from "../../sessions/model/session";
import {
  CHARS_PER_TOKEN,
  UNKNOWN_WINDOW,
} from "../../session-preamble/model/preamble";
import { propose, type MemoryProposal } from "./proposals";

/**
 * #36 "Suggest memories": a helper prompt over the chat, on the session's
 * own harness, account and model (rule 6 of the step 3c plan), so a local
 * chat's text never goes to another provider. It asks for plain lines, not a
 * tool call or JSON (rule 4), and every line becomes a proposal that waits
 * for the user's click.
 */

/** Rule 5: a helper prompt may use at most 40% of the window. */
export const SUGGEST_WINDOW_SHARE = 0.4;
export const SUGGEST_MAX = 5;
/** A helper prompt's base timeout, stretched for a model marked slow. */
export const SUGGEST_TIMEOUT_MS = 60_000;

export type SuggestSession = LocalitySession &
  Pick<Session, "id" | "cwd" | "harness" | "model" | "providerAccountId"> & {
    modelSettings?: Record<string, string>;
    blocks: readonly Block[];
  };

/** The newest user and assistant text that fits, oldest first. */
export function transcriptExcerpt(
  blocks: readonly Block[],
  maxChars: number,
): string {
  const lines: string[] = [];
  let used = 0;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block.role !== "user" && block.role !== "assistant") continue;
    const body = (block.text ?? "").trim();
    if (!body) continue;
    const line = `${block.role === "user" ? "User" : "Agent"}: ${body}`;
    if (used + line.length + 2 > maxChars) {
      const room = maxChars - used - 2;
      if (room > 200 && !lines.length) lines.push(line.slice(-room));
      break;
    }
    lines.push(line);
    used += line.length + 2;
  }
  return lines.reverse().join("\n\n");
}

export function suggestPrompt(excerpt: string): string {
  return `Below is part of a chat between a user and a coding agent about one project. List up to ${SUGGEST_MAX} facts worth remembering for later chats on this project: decisions, the user's preferences, how the project is built, tested or deployed, and where things live. Leave out anything that only mattered for this task, and never include secrets, tokens or passwords.

Reply with one fact per line, each starting with "- ". Reply with only NONE if nothing is worth remembering.

<chat>
${excerpt}
</chat>`;
}

/** Plain lines out of whatever the model wrote, loosely. */
export function parseSuggestions(reply: string): string[] {
  if (/^\s*NONE\s*$/i.test(reply)) return [];
  const out: string[] = [];
  for (const raw of reply.split("\n")) {
    const match = raw.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/);
    if (!match) continue;
    const fact = match[1].replace(/^\*\*|\*\*$/g, "").trim();
    if (!fact || fact.length > MEMORY_ENTRY_MAX) continue;
    if (/^none\b/i.test(fact)) continue;
    if (out.includes(fact)) continue;
    out.push(fact);
    if (out.length >= SUGGEST_MAX) break;
  }
  return out;
}

/** The native id the session's harness expects, or undefined for its default. */
export function suggestModelId(model: string | undefined): string | undefined {
  const id = model?.trim() ? nativeModelId(model).trim() : "";
  return id || undefined;
}

export type SuggestResult =
  { ok: true; proposals: MemoryProposal[] } | { ok: false; reason: string };

export async function suggestMemories(
  session: SuggestSession,
  options: { signal?: AbortSignal; now?: number } = {},
): Promise<SuggestResult> {
  if (!session.cwd || session.cwd === "~")
    return { ok: false, reason: "This chat has no project." };
  if (!canRunHarnessTextPrompt(session.harness))
    return {
      ok: false,
      reason:
        "This harness cannot run a side prompt. Add memories by hand on the Memory page.",
    };
  const window = modelBudgetWindow(session.model) ?? UNKNOWN_WINDOW;
  const maxChars = Math.floor(window * SUGGEST_WINDOW_SHARE * CHARS_PER_TOKEN);
  const excerpt = transcriptExcerpt(session.blocks, maxChars);
  if (!excerpt) return { ok: false, reason: "Nothing in this chat yet." };
  // Mac finding 2.9: the harness wants its own model id (`qwen2.5:7b`), not
  // MonoCode's key (`codex:qwen2.5:7b`). With no native id the harness uses
  // its default, as helper prompts do in helperPrompt.ts.
  const model = suggestModelId(session.model);
  let reply: string;
  try {
    reply = await runHarnessTextPrompt({
      harness: session.harness,
      cwd: session.cwd,
      providerAccountId: session.providerAccountId,
      ...(model ? { model, modelSettings: session.modelSettings } : {}),
      prompt: suggestPrompt(excerpt),
      timeoutMs: SUGGEST_TIMEOUT_MS * modelTimeoutFactor(session.model),
      signal: options.signal,
    });
  } catch (error) {
    // Corner case 2 and 3: a model that answers nothing, or too slowly, ends
    // here and the user adds memory by hand.
    return {
      ok: false,
      reason: `The model did not answer: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const facts = parseSuggestions(reply);
  if (!facts.length) return { ok: true, proposals: [] };
  const local = isLocal(sessionIsLocal(session));
  const proposals = await propose(
    session.cwd,
    facts.map((fact) => ({
      fact,
      local,
      source: "suggested" as const,
      sessionId: session.id,
    })),
    options.now,
  );
  return { ok: true, proposals };
}
