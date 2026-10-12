import {
  editProjectContext,
  readProjectContext,
} from "../../project-context/model/projectContext";
import { MEMORY_ENTRY_MAX, redactSecrets } from "../../monos/model/monoMemory";
import { addProjectMemory, replaceProjectMemory } from "./projectMemory";

/**
 * Memory entries waiting for the user's click (#36). An agent's
 * `memory.add` in a regular session and "Suggest memories" both land here.
 * Nothing reaches MEMORY.md until the user accepts it, because an agent can
 * be steered by text it read (security item 5).
 *
 * The app CLI times out after 35 seconds, so an agent's proposal is stored
 * and answered at once; the decision comes later.
 */
export type MemoryProposal = {
  id: string;
  fact: string;
  local: boolean;
  until?: string;
  /** Text of the entry this one supersedes, for memory.replace. */
  replaces?: string;
  /** "agent" from the app CLI, "suggested" from Suggest memories. */
  source: "agent" | "suggested";
  sessionId?: string;
  at: number;
};

export const PROPOSALS_MAX = 50;

export function parseProposals(text: string | null): MemoryProposal[] {
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value): MemoryProposal[] => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      if (typeof item.id !== "string" || typeof item.fact !== "string")
        return [];
      const fact = item.fact.trim();
      if (!fact || fact.length > MEMORY_ENTRY_MAX) return [];
      return [
        {
          id: item.id.slice(0, 64),
          fact,
          local: item.local === true,
          ...(typeof item.until === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(item.until)
            ? { until: item.until }
            : {}),
          ...(typeof item.replaces === "string" && item.replaces.trim()
            ? { replaces: item.replaces.slice(0, 2000) }
            : {}),
          source: item.source === "suggested" ? "suggested" : "agent",
          ...(typeof item.sessionId === "string"
            ? { sessionId: item.sessionId.slice(0, 256) }
            : {}),
          at: typeof item.at === "number" ? item.at : 0,
        },
      ];
    });
  } catch {
    return [];
  }
}

function serialize(list: MemoryProposal[]): string {
  return `${JSON.stringify(list, null, 2)}\n`;
}

export async function loadProposals(
  project: string,
): Promise<MemoryProposal[]> {
  return parseProposals(
    (await readProjectContext(project, "proposals.json")).text,
  );
}

let counter = 0;
function proposalId(now: number): string {
  counter = (counter + 1) % 1_000_000;
  return `p${now.toString(36)}${counter.toString(36)}`;
}

/** Add proposals, dropping repeats of a fact already waiting. */
export async function propose(
  project: string,
  items: Omit<MemoryProposal, "id" | "at">[],
  now = Date.now(),
): Promise<MemoryProposal[]> {
  return editProjectContext(project, "proposals.json", (text) => {
    const list = parseProposals(text);
    const added: MemoryProposal[] = [];
    for (const item of items) {
      const fact = redactSecrets(item.fact).replace(/\s+/g, " ").trim();
      if (!fact || fact.length > MEMORY_ENTRY_MAX) continue;
      if (list.some((existing) => existing.fact === fact)) continue;
      const proposal: MemoryProposal = {
        ...item,
        fact,
        id: proposalId(now),
        at: now,
      };
      list.push(proposal);
      added.push(proposal);
    }
    // Oldest go first when the list is full.
    const kept = list.slice(-PROPOSALS_MAX);
    return {
      text: serialize(kept),
      result: added.filter((p) => kept.includes(p)),
    };
  });
}

async function take(
  project: string,
  id: string,
): Promise<MemoryProposal | undefined> {
  return editProjectContext(project, "proposals.json", (text) => {
    const list = parseProposals(text);
    const found = list.find((item) => item.id === id);
    return {
      text: found
        ? serialize(list.filter((item) => item.id !== id))
        : (text ?? ""),
      result: found,
    };
  });
}

/** Save the proposal to memory, with the user's edits if any. */
export async function acceptProposal(
  project: string,
  id: string,
  edit?: { fact?: string; local?: boolean },
): Promise<boolean> {
  const proposal = await take(project, id);
  if (!proposal) return false;
  const fact = edit?.fact ?? proposal.fact;
  const options = {
    local: edit?.local ?? proposal.local,
    until: proposal.until,
  };
  if (proposal.replaces) {
    try {
      await replaceProjectMemory(project, proposal.replaces, fact, options);
      return true;
    } catch {
      // The entry it replaces is gone or ambiguous: keep the new fact.
    }
  }
  await addProjectMemory(project, fact, options);
  return true;
}

export async function rejectProposal(
  project: string,
  id: string,
): Promise<void> {
  await take(project, id);
}
