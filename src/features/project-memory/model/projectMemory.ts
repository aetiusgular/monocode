import {
  addMemoryEntry,
  archiveMemoryEntries,
  fitMemoryBudget,
  memoryDate,
  memoryEntry,
  memoryLines,
  removeMemoryEntry,
  searchMemory,
  supersedeMemoryEntry,
  type MemoryHit,
} from "../../monos/model/monoMemory";
import {
  editProjectContext,
  readProjectContext,
  saveProjectContext,
  ContextFileConflict,
} from "../../project-context/model/projectContext";
import type { PreamblePart } from "../../session-preamble/model/preamble";

/**
 * #36: project memory owned by MonoCode. One Markdown file per project in the
 * app's data folder, with dated one-line entries, kept with the Mono memory
 * code (add, supersede, remove, archive, budget). Each harness keeps memory
 * its own way and loses it on a switch; this one follows the project.
 *
 * An entry can be marked local only. It is written `- 2026-10-11 · [local]
 * fact` and goes only to a session the locality contract calls "local".
 */

export const LOCAL_MARK = "[local]";

export type ProjectMemoryEntry = {
  index: number;
  text: string;
  date?: string;
  until?: string;
  struck: boolean;
  local: boolean;
};

export function memoryEntries(text: string): ProjectMemoryEntry[] {
  return memoryLines(text).map((line) => {
    const local = line.text.startsWith(`${LOCAL_MARK} `);
    return {
      ...line,
      text: local ? line.text.slice(LOCAL_MARK.length + 1) : line.text,
      local,
    };
  });
}

/** The fact as stored: with its local mark, when it has one. */
function storedFact(fact: string, local: boolean): string {
  const text = fact.trim().replace(/^\[local\]\s*/i, "");
  return local ? `${LOCAL_MARK} ${text}` : text;
}

export type MemoryAddResult = {
  added: boolean;
  entry: string;
  /** Lines moved to the archive to keep the file within what loads. */
  moved: string[];
};

/** Keep MEMORY.md within what loads, moving the oldest entries to the archive. */
async function keepInBudget(
  project: string,
  keep: string,
  date: string,
): Promise<string[]> {
  const memory = await readProjectContext(project, "MEMORY.md");
  const fitted = fitMemoryBudget(memory.text ?? "", keep, date);
  if (!fitted.moved.length) return [];
  // The archive is written first, so a line is never out of one file
  // without already being in the other.
  await editProjectContext(project, "archive.md", (archive) => ({
    text: archiveMemoryEntries(archive, fitted.moved, date),
    result: undefined,
  }));
  try {
    await saveProjectContext(project, "MEMORY.md", fitted.text, memory.hash);
  } catch (error) {
    if (!(error instanceof ContextFileConflict)) throw error;
    return [];
  }
  return fitted.moved;
}

export async function addProjectMemory(
  project: string,
  fact: string,
  options: { local?: boolean; until?: string; now?: Date } = {},
): Promise<MemoryAddResult> {
  const date = memoryDate(options.now ?? new Date());
  const entry = memoryEntry(
    storedFact(fact, options.local === true),
    date,
    options.until,
  );
  const added = await editProjectContext(project, "MEMORY.md", (text) => {
    const next = addMemoryEntry(text, entry);
    return { text: next.text, result: next.added };
  });
  const moved = added ? await keepInBudget(project, entry, date) : [];
  return { added, entry, moved };
}

export async function replaceProjectMemory(
  project: string,
  find: string,
  fact: string,
  options: { local?: boolean; until?: string; now?: Date } = {},
): Promise<string> {
  const date = memoryDate(options.now ?? new Date());
  const entry = memoryEntry(
    storedFact(fact, options.local === true),
    date,
    options.until,
  );
  await editProjectContext(project, "MEMORY.md", (text) => ({
    text: supersedeMemoryEntry(text, find, entry, date),
    result: undefined,
  }));
  await keepInBudget(project, entry, date);
  return entry;
}

export async function removeProjectMemory(
  project: string,
  find: string,
): Promise<string> {
  return editProjectContext(project, "MEMORY.md", (text) => {
    const next = removeMemoryEntry(text, find);
    return { text: next.text, result: next.removed };
  });
}

export async function searchProjectMemory(
  project: string,
  query: string,
  since?: string,
): Promise<MemoryHit[]> {
  const [memory, archive] = await Promise.all([
    readProjectContext(project, "MEMORY.md"),
    readProjectContext(project, "archive.md"),
  ]);
  return searchMemory(
    [
      { file: "MEMORY.md", text: memory.text ?? "" },
      { file: "archive.md", text: archive.text ?? "" },
    ],
    query,
    { since },
  );
}

/**
 * What goes into a session's preamble: live entries in file order, oldest
 * first, so the budget cuts the oldest. Struck-through and expired entries
 * stay out, and so do local-only entries unless the session is local.
 */
export function memoryPart(
  text: string,
  options: { local: boolean; today: string },
): PreamblePart | undefined {
  const lines = memoryEntries(text)
    .filter((entry) => !entry.struck)
    .filter((entry) => !entry.until || entry.until >= options.today)
    .filter((entry) => options.local || !entry.local)
    .map(
      (entry) =>
        `- ${entry.date ? `${entry.date} · ` : ""}${entry.text}${
          entry.until ? ` · until ${entry.until}` : ""
        }`,
    );
  if (!lines.length) return undefined;
  return {
    id: "memory",
    label: "Project memory",
    text: lines.join("\n"),
    lines,
  };
}

/** How many entries a hosted session does not get. */
export function localOnlyCount(text: string): number {
  return memoryEntries(text).filter((entry) => entry.local && !entry.struck)
    .length;
}

/**
 * Remove one line by its index, only if it still holds `line`: another window
 * may have moved it.
 */
export async function removeEntryAt(
  project: string,
  index: number,
  line: string,
): Promise<boolean> {
  return editProjectContext(project, "MEMORY.md", (text) => {
    const lines = text.split("\n");
    if (lines[index]?.trim() !== line.trim()) return { text, result: false };
    lines.splice(index, 1);
    return { text: lines.join("\n"), result: true };
  });
}

/** Mark one entry local only, or share it with hosted sessions again. */
export async function setEntryLocal(
  project: string,
  index: number,
  line: string,
  local: boolean,
): Promise<boolean> {
  return editProjectContext(project, "MEMORY.md", (text) => {
    const lines = text.split("\n");
    const current = lines[index];
    if (current?.trim() !== line.trim()) return { text, result: false };
    const bare = current.replace(
      /(^-\s+(?:\d{4}-\d{2}-\d{2} · )?)\[local\] /,
      "$1",
    );
    lines[index] = local
      ? bare.replace(/^(-\s+(?:\d{4}-\d{2}-\d{2} · )?)/, `$1${LOCAL_MARK} `)
      : bare;
    return { text: lines.join("\n"), result: true };
  });
}

/** The raw line an entry came from, for the two edits above. */
export function lineAt(text: string, index: number): string {
  return text.split("\n")[index] ?? "";
}
