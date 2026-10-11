import { RECORD_SKILL_PROMPT_LEAD } from "./sessionOutline";

/**
 * A frontmatter value on one line. Quoted (as a JSON string, which YAML reads
 * as a double-quoted scalar) only when plain YAML would misread it.
 */
export function yamlScalar(value: string): string {
  const plain =
    !/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
    !/\s$/.test(value) &&
    !/:\s|\s#|:$/.test(value);
  return plain ? value : JSON.stringify(value);
}

/**
 * The turn MonoCode sends to record a skill. The frontmatter and the size
 * rule follow MonoCode's own `/create-skill` (name matches the folder,
 * description says what and when, under 500 lines).
 */
export function recordSkillPrompt(input: {
  name: string;
  description: string;
  file: string;
  outline: string;
}): string {
  return [
    RECORD_SKILL_PROMPT_LEAD,
    "",
    `Write exactly one file: \`${input.file}\``,
    "Create its folder if needed. Do not create, edit, move or delete any other file. Do not redo this session's work and do not run its commands again. If the file already exists, stop and tell me instead of overwriting it.",
    "",
    "Start the file with this YAML frontmatter, exactly as written:",
    "",
    "```yaml",
    "---",
    `name: ${input.name}`,
    `description: ${yamlScalar(input.description)}`,
    "---",
    "```",
    "",
    "Then write a Markdown body that turns what this session did into reusable steps for next time. Generalize: where a name, path or value would change from one use to the next, write a placeholder like <branch> instead. Use these sections:",
    "",
    "- `## Inputs`: what to ask the user for, or find out, before starting.",
    "- `## Steps`: the steps in order.",
    "- `## Commands and tools`: the commands, tools and files involved, and what each is for.",
    "- `## Checks`: how to confirm each step worked and the result is right.",
    "- `## Pitfalls`: problems seen in this session and how to avoid them. Leave this section out if there were none.",
    "",
    "Rules:",
    "- Leave out secrets, tokens, passwords, keys, credentials and personal data such as names, emails, addresses and phone numbers. Use placeholders like <API_TOKEN>.",
    "- Keep the file under 500 lines. Short, concrete steps over prose.",
    "- The conversation is the source of truth. The outline below only saves you rereading it.",
    "",
    "When done, reply with the file path and one line on what the skill covers.",
    "",
    "Session outline, built by MonoCode from the transcript:",
    "",
    quoteLines(input.outline),
  ].join("\n");
}

/**
 * The outline as a Markdown blockquote. MonoCode does not expand a `/name`
 * inside a quote, so a prompt or command in the outline that mentions a
 * skill cannot pull that skill into this turn.
 */
function quoteLines(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}
