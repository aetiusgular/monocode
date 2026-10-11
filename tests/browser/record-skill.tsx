import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { recordSkillPrompt } from "../../src/features/skill-recording/model/recordSkillPrompt";
import { buildSessionOutline } from "../../src/features/skill-recording/model/sessionOutline";
import { recordSkillMenu } from "../../src/features/skill-recording/model/skillRecording";
import {
  RecordSkillDialog,
  type RecordSkillIo,
} from "../../src/features/skill-recording/ui/RecordSkillDialog";
import { RecordSkillMenuItem } from "../../src/features/skill-recording/ui/RecordSkillMenuItem";
import {
  newSession,
  type Block,
  type HarnessId,
  type Session,
} from "../../src/features/sessions/model/session";
import { applyHarnessEvent } from "../../src/integrations/harness/core/apply";
import {
  previewFromTool,
  toolKindFromName,
  toolTitle,
} from "../../src/integrations/harness/providers/claude/claudeProtocol";
import { Popover } from "../../src/shared/ui/Popover";
import "../../src/styles/index.css";

const PARAMS = new URLSearchParams(location.search);
const HARNESS: HarnessId =
  PARAMS.get("harness") === "codex" ? "codex" : "claude";
const CWD = "/home/dev/storefront";
const HOME = "/home/dev";

/** A finished chat: one prompt, a few calls, a reply. */
function fixtureBlocks(): Block[] {
  let session: Session = {
    ...newSession(HARNESS, CWD),
    id: "fixture",
    blocks: [
      {
        id: "u1",
        role: "user",
        text: "The checkout test fails on CI only. Find out why and fix it.",
      },
    ],
  };
  const calls: [string, Record<string, unknown>][] = [
    ["Bash", { command: "npm test -- checkout" }],
    ["Read", { file_path: `${CWD}/src/checkout/charge.ts` }],
    [
      "Edit",
      {
        file_path: `${CWD}/src/checkout/charge.ts`,
        old_string: "retry()",
        new_string: "retry({ idempotencyKey })",
      },
    ],
    ["Bash", { command: "npm test -- checkout" }],
  ];
  calls.forEach(([name, input], index) => {
    const base = {
      callId: `call_${index}`,
      title: toolTitle(name, input),
      kind: toolKindFromName(name),
    };
    session = applyHarnessEvent(session, {
      type: "tool.started",
      ...base,
      status: "pending",
      preview: previewFromTool(name, input),
    });
    session = applyHarnessEvent(session, {
      type: "tool.updated",
      ...base,
      status: "completed",
      detail: "ok",
      preview: previewFromTool(name, input, "ok"),
    });
  });
  return [
    ...session.blocks,
    { id: "a1", role: "assistant", text: "Fixed. Charges now reuse the key." },
  ];
}

const BLOCKS = fixtureBlocks();

/** A folder that already holds a skill named `deploy`. */
const IO: RecordSkillIo = {
  homeDir: () => Promise.resolve(HOME),
  listFolder: (path) =>
    path.startsWith(CWD) ? Promise.resolve(["deploy"]) : Promise.reject(),
};

const sent: {
  prompts: string[];
  expected: (input: {
    name: string;
    description: string;
    file: string;
  }) => string;
} = {
  prompts: [],
  expected: (input) =>
    recordSkillPrompt({
      ...input,
      outline: buildSessionOutline(BLOCKS, { harness: HARNESS, cwd: CWD }),
    }),
};
(window as unknown as { __record: typeof sent }).__record = sent;

function Fixture() {
  const [open, setOpen] = useState<"plus" | "record" | null>(null);
  const plus = useRef<HTMLDivElement>(null);
  const plusButton = useRef<HTMLButtonElement>(null);
  const menu = recordSkillMenu({
    available: true,
    remote: false,
    harness: HARNESS,
    blocks: BLOCKS,
    busy: false,
  });
  return (
    <div className="flex h-full min-h-0 flex-col justify-end bg-background-base text-content">
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
          {open === "plus" && menu.visible ? (
            <Popover
              anchor={plus}
              side="top"
              align="start"
              width={250}
              onDismiss={() => setOpen(null)}
              data-composer-plus
              className="p-1.5"
            >
              <RecordSkillMenuItem
                disabled={menu.disabled}
                hint={menu.hint}
                onOpen={() => setOpen("record")}
              />
            </Popover>
          ) : null}
          {open === "record" &&
          (HARNESS === "claude" || HARNESS === "codex") ? (
            <RecordSkillDialog
              anchor={plus}
              harness={HARNESS}
              projectCwd={CWD}
              blocks={BLOCKS}
              catalogNames={["review-pr", "create-skill"]}
              io={IO}
              onRecord={(prompt) => {
                sent.prompts.push(prompt);
              }}
              onDismiss={(reason) => {
                setOpen(null);
                if (reason !== "outside") plusButton.current?.focus();
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
