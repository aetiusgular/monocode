import { MEMORY_ENTRY_MAX } from "../../monos/model/monoMemory";
import {
  isLocal,
  sessionLocalityNow,
  type LocalitySession,
} from "../../server-locality/model/locality";
import { addProjectMemory, type MemoryAddResult } from "./projectMemory";
import { projectName } from "../../../shared/lib/paths";

/**
 * The longest selection "Remember this" saves, in characters once spaces are
 * folded. It leaves room in one memory entry for the local mark.
 */
export const REMEMBER_MAX = MEMORY_ENTRY_MAX - 20;

/**
 * #36 "Remember this": the user saves a selection or a reply to the
 * project's memory. It is the user's own click, so it is saved at once, not
 * proposed. What a local session showed stays local only. The text is saved
 * whole or not at all: a selection longer than REMEMBER_MAX is refused with
 * the limit named, never cut (Mac 2.8). The reason is short, so the menu
 * can show it whole after "Could not remember this."
 */
export function rememberableText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length > REMEMBER_MAX)
    throw new Error(
      `This selection is ${flat.length.toLocaleString("en-US")} characters. A memory entry holds at most ${REMEMBER_MAX.toLocaleString("en-US")}.`,
    );
  return flat;
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
    local: isLocal(await sessionLocalityNow(session)),
  });
}

/** The line the transcript shows once "Remember this" has saved (Mac 2.8). */
export function rememberedNotice(
  project: string,
  result: Pick<MemoryAddResult, "added">,
): string {
  const name = projectName(project);
  return result.added
    ? `Remembered for ${name}.`
    : `Already remembered for ${name}.`;
}
