import {
  isLocal,
  sessionLocalityNow,
  type LocalitySession,
} from "../../server-locality/model/locality";
import { chatContextPrefs } from "../../session-preamble/model/chatContext";
import { readProjectContext } from "../../project-context/model/projectContext";
import { MEMORY_ENTRY_MAX, sinceDate } from "../../monos/model/monoMemory";
import { memoryEntries, searchProjectMemory } from "./projectMemory";
import { propose } from "./proposals";

/**
 * #36: the app CLI's memory actions in a regular session with app access
 * (/operator). Monos keep their own memory; this is the project's.
 *
 * An agent can read and search, and propose. A proposal is stored and
 * answered at once, because a CLI call times out after 35 seconds; nothing
 * reaches the memory until the user accepts it in MonoCode. Removing an
 * entry is the user's. A chat with memory switched off can do none of it.
 */
export type AgentMemorySession = LocalitySession & {
  id: string;
  cwd: string;
};

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must be a non-empty string`);
  if (value.length > max) throw new Error(`${name} is over ${max} characters`);
  return value.trim();
}

function noTopic(input: Record<string, unknown>) {
  if (input.topic !== undefined)
    throw new Error(
      "Project memory has no topic files. Leave topic out; one line per fact.",
    );
}

export async function handleProjectMemory(
  source: AgentMemorySession,
  action: string,
  input: Record<string, unknown>,
  now: Date = new Date(),
): Promise<unknown> {
  if (chatContextPrefs(source.id).memoryOff)
    throw new Error(
      "Memory is switched off in this chat. The user can turn it on in the session panel.",
    );
  const project = source.cwd;
  if (!project || project === "~")
    throw new Error("This session has no project, so it has no project memory");
  noTopic(input);
  const local = isLocal(await sessionLocalityNow(source));
  switch (action) {
    case "memory.read": {
      const memory = await readProjectContext(project, "MEMORY.md");
      const entries = memoryEntries(memory.text ?? "").filter(
        (entry) => !entry.struck && (local || !entry.local),
      );
      return {
        file: "project memory",
        entries: entries.map((entry) => ({
          fact: entry.text,
          ...(entry.date ? { date: entry.date } : {}),
          ...(entry.until ? { until: entry.until } : {}),
        })),
      };
    }
    case "memory.search": {
      const query =
        input.query === undefined ? "" : text(input.query, "query", 500);
      const since =
        input.since === undefined
          ? undefined
          : sinceDate(text(input.since, "since", 20), now);
      const hits = (await searchProjectMemory(project, query, since)).filter(
        (hit) => local || !hit.line.includes("[local]"),
      );
      return hits.length
        ? { hits }
        : { hits, note: "Nothing in project memory matches." };
    }
    case "memory.add":
    case "memory.replace": {
      const fact = text(input.fact, "fact", MEMORY_ENTRY_MAX);
      const until =
        input.until === undefined ? undefined : text(input.until, "until", 10);
      if (until !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(until))
        throw new Error("until must be a date like 2026-10-31");
      const replaces =
        action === "memory.replace"
          ? text(input.find, "find", 2000)
          : undefined;
      const [proposal] = await propose(
        project,
        [
          {
            fact,
            // What a local session learned stays local until the user says
            // otherwise.
            local,
            ...(until ? { until } : {}),
            ...(replaces ? { replaces } : {}),
            source: "agent",
            sessionId: source.id,
          },
        ],
        now.getTime(),
      );
      return proposal
        ? {
            proposed: fact,
            note: "Saved as a proposal. The user accepts or dismisses it in MonoCode; do not wait for it.",
          }
        : { proposed: false, note: "The same fact is already waiting." };
    }
    case "memory.remove":
      throw new Error(
        "Only the user removes project memory. Tell them which entry is wrong.",
      );
  }
  throw new Error(`Unknown app action: ${action}`);
}
