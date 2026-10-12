import { MEMORY_ENTRY_MAX } from "../../monos/model/monoMemory";
import {
  isLocal,
  sessionIsLocal,
  type LocalitySession,
} from "../../server-locality/model/locality";
import { addProjectMemory, type MemoryAddResult } from "./projectMemory";

/**
 * #36 "Remember this": the user saves a selection or a reply to the
 * project's memory. It is the user's own click, so it is saved at once, not
 * proposed. What a local session showed stays local only.
 */
export function rememberableText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MEMORY_ENTRY_MAX - 20) return flat;
  return `${flat.slice(0, MEMORY_ENTRY_MAX - 21).trimEnd()}…`;
}

export async function rememberText(
  project: string | undefined,
  text: string,
  session: LocalitySession,
): Promise<MemoryAddResult> {
  if (!project || project === "~")
    throw new Error("This chat has no project to remember it for");
  const fact = rememberableText(text);
  if (!fact) throw new Error("Nothing to remember");
  return addProjectMemory(project, fact, {
    local: isLocal(sessionIsLocal(session)),
  });
}
