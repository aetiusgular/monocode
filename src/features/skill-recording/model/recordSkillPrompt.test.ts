import { describe, expect, it } from "vitest";
import { skillNamesInText } from "../../skills/model/skills";
import { isMarkdownBlockquotePosition } from "../../sessions/model/quoteDraft";
import { recordSkillPrompt, yamlScalar } from "./recordSkillPrompt";
import { RECORD_SKILL_PROMPT_LEAD } from "./sessionOutline";

const INPUT = {
  name: "fix-flaky-test",
  description: "Use when a test fails only on CI.",
  file: "/repo/.claude/skills/fix-flaky-test/SKILL.md",
  outline: "Prompts, in order:\n1. Fix it.\n\nCommands run:\n- `npm test`",
};

describe("recordSkillPrompt", () => {
  const prompt = recordSkillPrompt(INPUT);

  it("starts with the recording lead", () => {
    expect(prompt.startsWith(`${RECORD_SKILL_PROMPT_LEAD}\n`)).toBe(true);
  });

  it("names exactly one file and forbids other changes", () => {
    expect(prompt).toContain(
      "Write exactly one file: `/repo/.claude/skills/fix-flaky-test/SKILL.md`",
    );
    expect(prompt).toContain(
      "Do not create, edit, move or delete any other file.",
    );
    expect(prompt).toContain("Do not redo this session's work");
    expect(prompt).toContain("stop and tell me instead of overwriting it");
  });

  it("gives the exact frontmatter", () => {
    expect(prompt).toContain(
      "---\nname: fix-flaky-test\ndescription: Use when a test fails only on CI.\n---",
    );
  });

  it("asks for inputs, steps, commands, checks and pitfalls", () => {
    for (const heading of [
      "## Inputs",
      "## Steps",
      "## Commands and tools",
      "## Checks",
      "## Pitfalls",
    ]) {
      expect(prompt).toContain(`\`${heading}\``);
    }
  });

  it("asks to leave out secrets and personal data", () => {
    expect(prompt).toContain(
      "Leave out secrets, tokens, passwords, keys, credentials and personal data",
    );
  });

  it("ends with the outline as a quote", () => {
    expect(
      prompt.endsWith(
        "> Prompts, in order:\n> 1. Fix it.\n>\n> Commands run:\n> - `npm test`",
      ),
    ).toBe(true);
  });

  it("does not expand a skill named in the outline", () => {
    const text = recordSkillPrompt({
      ...INPUT,
      outline: "Prompts, in order:\n1. run /deploy now",
    });
    // MonoCode skips `/name` inside a quote when it expands skills.
    expect(skillNamesInText(text)).toEqual([]);
    const at = text.indexOf("/deploy");
    expect(isMarkdownBlockquotePosition(text, at)).toBe(true);
  });

  it("matches the full text", () => {
    expect(prompt).toMatchInlineSnapshot(`
      "Record a skill from this session.

      Write exactly one file: \`/repo/.claude/skills/fix-flaky-test/SKILL.md\`
      Create its folder if needed. Do not create, edit, move or delete any other file. Do not redo this session's work and do not run its commands again. If the file already exists, stop and tell me instead of overwriting it.

      Start the file with this YAML frontmatter, exactly as written:

      \`\`\`yaml
      ---
      name: fix-flaky-test
      description: Use when a test fails only on CI.
      ---
      \`\`\`

      Then write a Markdown body that turns what this session did into reusable steps for next time. Generalize: where a name, path or value would change from one use to the next, write a placeholder like <branch> instead. Use these sections:

      - \`## Inputs\`: what to ask the user for, or find out, before starting.
      - \`## Steps\`: the steps in order.
      - \`## Commands and tools\`: the commands, tools and files involved, and what each is for.
      - \`## Checks\`: how to confirm each step worked and the result is right.
      - \`## Pitfalls\`: problems seen in this session and how to avoid them. Leave this section out if there were none.

      Rules:
      - Leave out secrets, tokens, passwords, keys, credentials and personal data such as names, emails, addresses and phone numbers. Use placeholders like <API_TOKEN>.
      - Keep the file under 500 lines. Short, concrete steps over prose.
      - The conversation is the source of truth. The outline below only saves you rereading it.

      When done, reply with the file path and one line on what the skill covers.

      Session outline, built by MonoCode from the transcript:

      > Prompts, in order:
      > 1. Fix it.
      >
      > Commands run:
      > - \`npm test\`"
    `);
  });
});

describe("yamlScalar", () => {
  it("leaves plain text plain", () => {
    expect(yamlScalar("Use when a test fails only on CI.")).toBe(
      "Use when a test fails only on CI.",
    );
    expect(yamlScalar("Ship v2.1 to staging")).toBe("Ship v2.1 to staging");
  });

  it("quotes text YAML would misread", () => {
    expect(yamlScalar("Use when: CI fails")).toBe('"Use when: CI fails"');
    expect(yamlScalar("- starts with a dash")).toBe('"- starts with a dash"');
    expect(yamlScalar("Fix it # now")).toBe('"Fix it # now"');
    expect(yamlScalar('"quoted"')).toBe('"\\"quoted\\""');
    expect(yamlScalar("[list]")).toBe('"[list]"');
  });
});
