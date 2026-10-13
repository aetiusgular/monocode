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

export async function preparePrompt(
  text: string,
  context: SkillTurnContext,
): Promise<string> {
  warmNativeSkills(context);
  if (isNativeCommandPrompt(text, context.harness))
    return nativeCommandPrompt(context.harness, text);
  const withFiles = await applyFileMentionsToTurn(text, context.cwd);
  const withNotes = await applyNotesToTurn(withFiles);
  const withSkills = await applySkillsToTurn(withNotes, context);
  // A harness that does not read `@path` itself gets the file text (3.13).
  return inlineFileMentionsForTurn(withSkills, text, context);
}
