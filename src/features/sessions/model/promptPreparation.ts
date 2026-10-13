import { applyFileMentionsToTurn } from "../../files/model/fileMentions";
import { inlineFileMentionsForTurn } from "../../files/model/inlineFileMentions";
import { applyNotesToTurn } from "../../notes";
import {
  applySkillsToTurn,
  warmNativeSkills,
  isNativeCommandPrompt,
  type SkillTurnContext,
} from "../../skills/model/skills";
import { nativeCommandPrompt } from "../../../integrations/harness/core/nativeCommands";

/**
 * What may be scanned for `@file` mentions to inline (3.13). Left out, nothing
 * is inlined. `typed` is the user's own composer text only: never a CI
 * repair prompt, a note card body or other text the user did not write.
 * `local` is true only when the chat's model route is local, so no file text
 * leaves the computer this way (security review of the Mac fixes, F1, F2).
 */
export type InlineMentionSource = { typed: string; local: boolean };

export async function preparePrompt(
  text: string,
  context: SkillTurnContext & { inline?: InlineMentionSource },
): Promise<string> {
  warmNativeSkills(context);
  if (isNativeCommandPrompt(text, context.harness))
    return nativeCommandPrompt(context.harness, text);
  const withFiles = await applyFileMentionsToTurn(text, context.cwd);
  const withNotes = await applyNotesToTurn(withFiles);
  const withSkills = await applySkillsToTurn(withNotes, context);
  // A harness that does not read `@path` itself gets the file text (3.13).
  if (!context.inline?.local || !context.inline.typed) return withSkills;
  return inlineFileMentionsForTurn(withSkills, context.inline.typed, context);
}
