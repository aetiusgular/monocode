import { describe, expect, it } from "vitest";
import { applyHarnessEvent } from "../../../integrations/harness/core/apply";
import {
  previewFromTool,
  toolKindFromName,
  toolTitle,
} from "../../../integrations/harness/providers/claude/claudeProtocol";
import {
  newSession,
  type Block,
  type Session,
} from "../../sessions/model/session";
import {
  buildSessionOutline,
  RECORD_SKILL_PROMPT_LEAD,
  redactSecrets,
} from "./sessionOutline";

type Step =
  { prompt: string } | { tool: string; input: Record<string, unknown> };

/** A Claude Code chat as the adapter leaves it: prompts and finished calls. */
function claudeChat(steps: Step[]): Block[] {
  let state: Session = { ...newSession("claude", "/repo"), id: "chat" };
  steps.forEach((step, index) => {
    if ("prompt" in step) {
      state = {
        ...state,
        blocks: [
          ...state.blocks,
          { id: `u${index}`, role: "user", text: step.prompt },
        ],
      };
      return;
    }
    const callId = `toolu_${index}`;
    const base = {
      callId,
      title: toolTitle(step.tool, step.input),
      kind: toolKindFromName(step.tool),
    };
    state = applyHarnessEvent(state, {
      type: "tool.started",
      ...base,
      status: "pending",
      preview: previewFromTool(step.tool, step.input),
    });
    state = applyHarnessEvent(state, {
      type: "tool.updated",
      ...base,
      status: "completed",
      detail: "ok",
      preview: previewFromTool(step.tool, step.input, "ok"),
    });
  });
  return state.blocks;
}

const CHAT = claudeChat([
  { prompt: "The checkout test fails on CI only. Fix it." },
  { tool: "Bash", input: { command: "npm test -- checkout" } },
  { tool: "Read", input: { file_path: "/repo/src/checkout/charge.ts" } },
  { tool: "Grep", input: { pattern: "idempotencyKey", path: "/repo/src" } },
  {
    tool: "Edit",
    input: {
      file_path: "/repo/src/checkout/charge.ts",
      old_string: "a",
      new_string: "b",
    },
  },
  { tool: "Bash", input: { command: "npm test -- checkout" } },
  { prompt: "Now commit it." },
  { tool: "Bash", input: { command: "git commit -am 'Fix charge retry'" } },
  { tool: "mcp__linear__create_comment", input: { body: "done" } },
]);

describe("buildSessionOutline", () => {
  it("lists prompts, commands, files and tools by name and target", () => {
    const outline = buildSessionOutline(CHAT, {
      harness: "claude",
      cwd: "/repo",
    });
    expect(outline).toContain("Prompts, in order:");
    expect(outline).toContain("1. The checkout test fails on CI only. Fix it.");
    expect(outline).toContain("2. Now commit it.");
    expect(outline).toContain("Commands run:");
    expect(outline).toMatch(/- `[^`]*npm test -- checkout[^`]*` \(x2\)/);
    expect(outline).toMatch(/git commit -am 'Fix charge retry'/);
    expect(outline).toContain("Files written or edited:");
    expect(outline).toMatch(
      /Files written or edited:\n- `src\/checkout\/charge\.ts`/,
    );
    expect(outline).toContain("Files read:");
    expect(outline).toContain("Project searches:");
    expect(outline).toContain("idempotencyKey");
    expect(outline).toContain("MCP tools:");
    expect(outline).toContain("`linear: create_comment`");
  });

  it("skips earlier recording turns and app-written turns", () => {
    const blocks: Block[] = [
      ...CHAT,
      { id: "rec", role: "user", text: `${RECORD_SKILL_PROMPT_LEAD}\n\nmore` },
      { id: "int", role: "user", text: "keep going", internal: true },
      { id: "dr", role: "user", text: "unsent", draft: true },
    ];
    const outline = buildSessionOutline(blocks);
    expect(outline).not.toContain(RECORD_SKILL_PROMPT_LEAD);
    expect(outline).not.toContain("keep going");
    expect(outline).not.toContain("unsent");
  });

  it("keeps the first and latest prompts of a long chat", () => {
    const blocks: Block[] = Array.from({ length: 30 }, (_, index) => ({
      id: `u${index}`,
      role: "user",
      text: `step ${index + 1}`,
    }));
    const outline = buildSessionOutline(blocks);
    expect(outline).toContain(
      "1. step 1\n2. step 2\n- 18 prompts in between not shown\n21. step 21",
    );
    expect(outline).toContain("30. step 30");
    expect(outline).not.toContain("step 3\n");
  });

  it("shortens long prompts to one line", () => {
    const outline = buildSessionOutline([
      { id: "u", role: "user", text: `first\nsecond ${"x".repeat(600)}` },
    ]);
    const line = outline.split("\n")[1];
    expect(line.startsWith("1. first second x")).toBe(true);
    expect(line.endsWith("...")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(403);
  });

  it("stays within the size cap", () => {
    const steps: Step[] = [{ prompt: "go" }];
    for (let index = 0; index < 200; index += 1) {
      steps.push({
        tool: "Bash",
        input: { command: `node scripts/task-${index}.js ${"y".repeat(150)}` },
      });
    }
    const outline = buildSessionOutline(claudeChat(steps), { maxChars: 1500 });
    expect(outline.length).toBeLessThanOrEqual(1500 + 60);
    expect(outline).toMatch(/\(Outline cut at 1500 characters\.\)$/);
    // The newest commands are kept, the rest counted.
    expect(outline).toContain("- 175 earlier not shown");
  });

  it("says so when there is nothing to outline", () => {
    expect(buildSessionOutline([])).toBe(
      "(The transcript has no prompts or tool calls.)",
    );
  });

  it("redacts secrets in prompts and commands", () => {
    const outline = buildSessionOutline(
      claudeChat([
        { prompt: "Use token ghp_abcdefghijklmnopqrstuvwxyz0123 to push" },
        {
          tool: "Bash",
          input: {
            command:
              "curl -H 'Authorization: Bearer abc.def.ghijklmnop' https://api.example.com",
          },
        },
      ]),
    );
    expect(outline).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(outline).not.toContain("abc.def.ghijklmnop");
    expect(outline).toContain("[redacted]");
  });
});

describe("redactSecrets", () => {
  it.each([
    ["OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234 npm start", "sk-proj"],
    ["export GITHUB_TOKEN=abc123secret", "abc123secret"],
    ["psql postgres://admin:hunter2@db.local/app", "hunter2"],
    ["deploy --password 'p@ss word' --env prod", "p@ss word"],
    [
      "aws configure set aws_access_key_id AKIAABCDEFGHIJKLMNOP",
      "AKIAABCDEFGHIJKLMNOP",
    ],
    ["slack xoxb-1234567890-abcdefghij", "xoxb-1234567890"],
    [
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
      "eyJhbGci",
    ],
  ])("hides the secret in %s", (text, secret) => {
    const out = redactSecrets(text);
    expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
  });

  it("leaves ordinary commands alone", () => {
    for (const text of [
      "npm test -- checkout",
      "git commit -am 'Fix charge retry'",
      "rg idempotencyKey src",
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });
});
