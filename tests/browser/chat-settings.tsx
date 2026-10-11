import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { chatDisabledSkills } from "../../src/features/chat-skills/model/chatSkills";
import { SkillsMenuItem } from "../../src/features/chat-skills/ui/SkillsMenuItem";
import { SkillsPopover } from "../../src/features/chat-skills/ui/SkillsPopover";
import {
  sessionToolsSummary,
  withSessionToolsPatch,
  type SessionToolsPatch,
} from "../../src/features/session-tools/model/harnessInput";
import {
  newSession,
  type ApprovalTool,
  type Block,
  type HarnessId,
  type Session,
} from "../../src/features/sessions/model/session";
import {
  saveTranscriptAnchor,
  saveTranscriptLayout,
} from "../../src/features/settings/model/appearance";
import {
  harnessToolAccess,
  toolRuleCount,
} from "../../src/features/tool-access/model/toolAccess";
import { useSessionApprovalRules } from "../../src/features/tool-access/ui/approvalRules";
import { ToolAccessMenuItem } from "../../src/features/tool-access/ui/ToolAccessMenuItem";
import { ToolAccessPopover } from "../../src/features/tool-access/ui/ToolAccessPopover";
import { TranscriptWithApprovalRules } from "../../src/features/tool-access/ui/TranscriptWithApprovalRules";
import type { Skill } from "../../src/features/skills/model/skills";
import { applyHarnessEvent } from "../../src/integrations/harness/core/apply";
import {
  previewFromTool,
  toolKindFromName,
  toolTitle,
} from "../../src/integrations/harness/providers/claude/claudeProtocol";
import { Popover } from "../../src/shared/ui/Popover";
import "../../src/styles/index.css";

saveTranscriptAnchor(false);
saveTranscriptLayout("chat");

const PARAMS = new URLSearchParams(location.search);
const HARNESS: HarnessId =
  PARAMS.get("harness") === "codex" ? "codex" : "claude";

/** An MCP tool whose name is longer than its row. */
const LONG_TOOL =
  "mcp__internal-knowledge-base__search_engineering_design_documents";

const fileSkill = (name: string, description: string): Skill => ({
  kind: "file",
  name,
  description,
  invocation: name,
  path: `/home/dev/storefront/.claude/skills/${name}/SKILL.md`,
  scope: "project",
  source: "claude",
});

/** The catalog the composer would have loaded for this chat. */
const SKILLS: Skill[] = [
  fileSkill("review-pr", "Review a pull request"),
  fileSkill(
    "deploy",
    "Ship the current branch to staging, wait for the smoke tests, and post the result in the release channel",
  ),
  fileSkill("triage-incoming-customer-support-tickets", "Sort the queue"),
  {
    kind: "builtin",
    name: "create-skill",
    description: "Create a new skill",
    invocation: "create-skill",
    scope: "builtin",
    source: "monocode",
  },
];

type Ask = { name: string; input: Record<string, unknown>; tool: ApprovalTool };

const ASKS: Ask[] =
  HARNESS === "codex"
    ? [
        {
          name: "Bash",
          input: { command: "npm test -- checkout" },
          tool: { key: "codex:command", label: "Commands" },
        },
        {
          name: "Edit",
          input: { file_path: "/home/dev/storefront/src/checkout/charge.ts" },
          tool: { key: "codex:file-change", label: "File edits" },
        },
      ]
    : [
        {
          name: "Bash",
          input: { command: "npm test -- checkout" },
          tool: { key: "Bash", label: "Bash" },
        },
        {
          name: LONG_TOOL,
          input: { query: "idempotency keys" },
          tool: {
            key: LONG_TOOL,
            label:
              "internal-knowledge-base: search_engineering_design_documents",
          },
        },
      ];

function fixtureSession(): Session {
  const user: Block = {
    id: "user",
    role: "user",
    text: "Customers are sometimes charged twice at checkout. Find out why.",
  };
  let session: Session = {
    ...newSession(HARNESS, "/home/dev/storefront"),
    id: "fixture",
    busy: true,
    blocks: [user],
  };
  ASKS.forEach((ask, index) => {
    const callId = `call_${index}`;
    session = applyHarnessEvent(session, {
      type: "tool.started",
      callId,
      title: toolTitle(ask.name, ask.input),
      kind: toolKindFromName(ask.name),
      status: "pending",
      preview: previewFromTool(ask.name, ask.input),
    });
    session = applyHarnessEvent(session, {
      type: "approval.requested",
      requestId: index + 1,
      title: toolTitle(ask.name, ask.input),
      kind: toolKindFromName(ask.name),
      callId,
      preview: previewFromTool(ask.name, ask.input),
      tool: ask.tool,
    });
  });
  return session;
}

/** What the page asked the app to do, for the spec to read back. */
const asked: { answers: string[]; opened: string[] } = {
  answers: [],
  opened: [],
};
(window as unknown as { __chat: typeof asked }).__chat = asked;

/** The pane cut down to the transcript and the composer's plus menu. */
function Fixture() {
  const [session, setSession] = useState(fixtureSession);
  const [open, setOpen] = useState<"plus" | "tool-access" | "skills" | null>(
    null,
  );
  const plus = useRef<HTMLDivElement>(null);
  const plusButton = useRef<HTMLButtonElement>(null);
  const change = (patch: SessionToolsPatch) =>
    setSession((current) => withSessionToolsPatch(current, patch));
  const approvalRules = useSessionApprovalRules(
    session.harness,
    session.toolAccess,
    (toolAccess) => change({ toolAccess }),
  );
  const summary = sessionToolsSummary(session, session.cwd);
  const skillsOff = chatDisabledSkills(session.harness, session.disabledSkills);
  return (
    <div className="flex h-full min-h-0 flex-col bg-background-base text-content">
      <div className="flex min-h-0 flex-1 flex-col">
        <TranscriptWithApprovalRules
          approvalRules={approvalRules}
          blocks={session.blocks}
          busy
          cwd={session.cwd}
          harness={session.harness}
          onApproval={(requestId, decision) => {
            asked.answers.push(`${requestId}:${decision}`);
            setSession((current) =>
              applyHarnessEvent(current, {
                type: "approval.resolved",
                requestId,
                decision,
              }),
            );
          }}
        />
      </div>
      <div className="flex items-center gap-2 border-t border-content/10 px-3 py-2">
        <div ref={plus} className="relative shrink-0">
          <button
            ref={plusButton}
            type="button"
            aria-label="Add files or choose a mode"
            onClick={() => setOpen((shown) => (shown ? null : "plus"))}
            className="grid size-7 place-items-center rounded-md bg-content/10 text-[13px]"
          >
            +
          </button>
          {open === "plus" ? (
            <Popover
              anchor={plus}
              side="top"
              align="start"
              width={250}
              onDismiss={() => setOpen(null)}
              data-composer-plus
              className="p-1.5"
            >
              <ToolAccessMenuItem
                ruleCount={toolRuleCount(
                  harnessToolAccess(session.harness, session.toolAccess),
                )}
                onOpen={() => setOpen("tool-access")}
              />
              <SkillsMenuItem
                offCount={skillsOff.length}
                onOpen={() => setOpen("skills")}
              />
            </Popover>
          ) : null}
          {open === "tool-access" ? (
            <ToolAccessPopover
              anchor={plus}
              harness={session.harness}
              toolAccess={session.toolAccess}
              blocks={session.blocks}
              onChange={(toolAccess) => change({ toolAccess })}
              onDismiss={(reason) => {
                setOpen(null);
                if (reason === "escape") plusButton.current?.focus();
              }}
            />
          ) : null}
          {open === "skills" ? (
            <SkillsPopover
              anchor={plus}
              harness={session.harness}
              skills={SKILLS}
              disabled={skillsOff}
              atTurnStart={null}
              onChange={(disabledSkills) => change({ disabledSkills })}
              onManage={() => {
                asked.opened.push("skills-settings");
                setOpen(null);
              }}
              onDismiss={(reason) => {
                setOpen(null);
                if (reason === "escape") plusButton.current?.focus();
              }}
            />
          ) : null}
        </div>
        <span data-summary className="text-[11px] text-content/70">
          {summary?.label ?? ""}
        </span>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
