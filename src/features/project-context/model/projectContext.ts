import { invoke } from "@tauri-apps/api/core";

/**
 * Files MonoCode keeps outside the repository for what it tells an agent
 * (#27, #36). They live in the app's data folder (`project_context.rs`),
 * which writes only a fixed list of names: global instructions, and per
 * project private notes, memory, its archive and pending proposals.
 */
export type GlobalContextFile = "instructions.md";
export type ProjectContextFile =
  | "notes.md"
  | "MEMORY.md"
  | "archive.md"
  | "proposals.json"
  /** Automation changes an agent asked for (#39). */
  | "automation-proposals.json";

export type ContextFile = { text: string | null; hash: string };

/** A save refused because the file changed since it was read. */
export class ContextFileConflict extends Error {
  constructor() {
    super("The file changed while you were editing");
  }
}

const CHANGED = "monocode:project-context-changed";

export function readGlobalContext(
  file: GlobalContextFile,
): Promise<ContextFile> {
  return invoke<ContextFile>("project_context_read", {
    scope: "global",
    project: null,
    file,
  });
}

export function readProjectContext(
  project: string,
  file: ProjectContextFile,
): Promise<ContextFile> {
  return invoke<ContextFile>("project_context_read", {
    scope: "project",
    project,
    file,
  });
}

async function save(
  scope: "global" | "project",
  project: string | null,
  file: string,
  text: string,
  expectedHash: string | undefined,
): Promise<string> {
  try {
    const hash = await invoke<string>("project_context_save", {
      scope,
      project,
      file,
      text,
      expectedHash: expectedHash ?? null,
    });
    if (typeof window !== "undefined")
      window.dispatchEvent(
        new CustomEvent(CHANGED, { detail: { project, file } }),
      );
    return hash;
  } catch (error) {
    if (error === "conflict") throw new ContextFileConflict();
    throw error;
  }
}

/** Saves over `expectedHash`; throws `ContextFileConflict` if it moved. */
export function saveGlobalContext(
  file: GlobalContextFile,
  text: string,
  expectedHash?: string,
): Promise<string> {
  return save("global", null, file, text, expectedHash);
}

/** Saves over `expectedHash`; throws `ContextFileConflict` if it moved. */
export function saveProjectContext(
  project: string,
  file: ProjectContextFile,
  text: string,
  expectedHash?: string,
): Promise<string> {
  return save("project", project, file, text, expectedHash);
}

/**
 * Reapply an edit to the latest text, retrying when another window saved in
 * between. Returns what `edit` reported.
 */
export async function editProjectContext<T>(
  project: string,
  file: ProjectContextFile,
  edit: (text: string) => { text: string; result: T },
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const current = await readProjectContext(project, file);
    const next = edit(current.text ?? "");
    if (next.text === (current.text ?? "")) return next.result;
    try {
      await saveProjectContext(project, file, next.text, current.hash);
      return next.result;
    } catch (error) {
      if (!(error instanceof ContextFileConflict) || attempt >= 2) throw error;
    }
  }
}

export function subscribeProjectContext(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGED, onChange);
  return () => window.removeEventListener(CHANGED, onChange);
}
