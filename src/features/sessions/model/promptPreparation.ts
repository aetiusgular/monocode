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
import { harnessCan } from "../../../integrations/harness/core/capabilities";
import {
  isLocal,
  modelRouteLocalityNow,
  type LocalitySession,
} from "../../server-locality/model/locality";

/**
 * What may be scanned for `@file` mentions to inline (3.13). Left out, nothing
 * is inlined. `typed` is the user's own composer text only: never a CI
 * repair prompt, a note card body or other text the user did not write.
 * `local` is true only when the chat's model route is local, so no file text
 * leaves the computer this way (security review of the Mac fixes, F1, F2).
 */
export type InlineMentionSource = { typed: string; local: boolean };

/**
 * The inline source for one turn. The model route is judged the way the
 * privacy panel's model row judges it, after asking the harness
 * (`modelRouteLocalityNow`), so a wrapper-home Codex whose own config names
 * a loopback provider counts as local even though MonoCode's Models page
 * does not list it. Hosted and unknown routes get nothing inlined. The
 * harness is asked only when the typed text mentions a file and the harness
 * takes inlined files.
 */
export async function inlineMentionSource(
  typed: string,
  session: LocalitySession,
): Promise<InlineMentionSource> {
  if (
    !typed ||
    !/(^|\s)@\S/.test(typed) ||
    !harnessCan(session.harness, "inlineFileMentions")
  )
    return { typed, local: false };
  return { typed, local: isLocal(await modelRouteLocalityNow(session)) };
}

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
