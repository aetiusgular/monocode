import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  SessionPanel,
  SessionPanelSlot,
  SessionPanelToggle,
  sessionHasPanel,
  useSessionPanel,
} from "../../src/features/session-panel";
import {
  newSession,
  type Block,
  type Session,
  type TaskListItem,
} from "../../src/features/sessions/model/session";
import { AgentTranscript } from "../../src/features/sessions/ui/AgentTranscript";
import {
  saveTranscriptAnchor,
  saveTranscriptLayout,
} from "../../src/features/settings/model/appearance";
import { applyHarnessEvent } from "../../src/integrations/harness/core/apply";
import {
  previewFromTool,
  toolKindFromName,
  toolTitle,
} from "../../src/integrations/harness/providers/claude/claudeProtocol";
import "../../src/styles/index.css";

saveTranscriptAnchor(false);
saveTranscriptLayout("chat");

type Call = [name: string, input: Record<string, unknown>];

const PROJECT = "/home/dev/storefront";
/** The worktree the session runs in, where every file it touches lives. */
const REPO = "/home/dev/worktrees/storefront-duplicate-charge";

const PARAMS = new URLSearchParams(location.search);
const LONG = PARAMS.get("steps") === "long";
/** Leave one command in flight, printing as it goes. */
const RUNNING = PARAMS.get("running") === "1";

/** What each command printed. A command not listed printed nothing. */
const OUTPUT: Record<string, string> = {
  "npm test -- checkout":
    " RUN  v3.2.7 /home/dev/storefront\n\n ✓ src/checkout/charge.test.ts (14 tests) 212ms\n\n Test Files  1 passed (1)\n      Tests  14 passed (14)",
  "npm run typecheck": "> storefront@2.4.0 typecheck\n> tsc --noEmit",
  "git diff --stat":
    " src/checkout/charge.ts | 6 ++++--\n src/checkout/retry.ts  | 2 +-\n 2 files changed, 5 insertions(+), 3 deletions(-)",
};

/** A plan long enough that the step list has to scroll. */
const longSteps: [string, string][] = [
  ...Array.from({ length: 23 }, (_, index): [string, string] => [
    `Earlier step ${index + 1}: trace one more caller of the charge request`,
    "completed",
  ]),
  ["Retry safely when the provider times out", "in_progress"],
  ...Array.from({ length: 8 }, (_, index): [string, string] => [
    `Later step ${index + 1}: cover one more retry path`,
    "pending",
  ]),
];

const shortSteps: [string, string][] = [
  ["Read the checkout flow and its tests", "completed"],
  ["Reproduce the duplicate-charge bug", "completed"],
  ["Check the open issue and linked pull requests", "completed"],
  ["Look up the payment provider's idempotency rules", "completed"],
  ["Add an idempotency key to the charge request", "completed"],
  ["Retry safely when the provider times out", "in_progress"],
  ["Cover the retry path with tests", "pending"],
  ["Run the full checkout suite", "pending"],
  ["Summarize the fix on the issue", "pending"],
];

const steps: TaskListItem[] = (LONG ? longSteps : shortSteps).map(
  ([text, status], index) => ({
    id: String(index + 1),
    text,
    status: status as TaskListItem["status"],
  }),
);

const calls: Call[] = [
  ["Read", { file_path: `${REPO}/src/checkout/charge.ts` }],
  ["Read", { file_path: `${REPO}/src/checkout/charge.test.ts` }],
  ["Grep", { pattern: "createCharge" }],
  ["Read", { file_path: `${REPO}/src/checkout/retry.ts` }],
  ["Bash", { command: "npm test -- checkout" }],
  ["mcp__github__get_issue", { number: 482 }],
  ["mcp__github__list_pull_requests", { state: "open" }],
  ["mcp__github__get_pull_request", { number: 479 }],
  ["mcp__linear__get_issue", { id: "PAY-311" }],
  ["WebSearch", { query: "payment provider idempotency key retry window" }],
  ["WebSearch", { query: "idempotent POST retry after timeout" }],
  ["Read", { file_path: `${REPO}/src/checkout/charge.ts`, offset: 120 }],
  [
    "Edit",
    {
      file_path: `${REPO}/src/checkout/charge.ts`,
      old_string: "await provider.charge(order)",
      new_string: "await provider.charge(order, { idempotencyKey })",
    },
  ],
  [
    "Edit",
    {
      file_path: `${REPO}/src/checkout/retry.ts`,
      old_string: "attempts: 1",
      new_string: "attempts: 3",
    },
  ],
  ["Bash", { command: "npm run typecheck" }],
  ["Bash", { command: "npm test -- checkout" }],
  ["Bash", { command: "git diff --stat" }],
  [
    "Write",
    {
      file_path: `${REPO}/docs/duplicate-charge.md`,
      content:
        "# Duplicate charge\n\nWhat went wrong and how the retry is now safe.\n",
    },
  ],
  [
    "Write",
    {
      file_path: `${REPO}/docs/retry-policy.md`,
      content: "# Retry policy\n",
    },
  ],
  [
    "Task",
    { description: "Review the retry change", subagent_type: "code-reviewer" },
  ],
];

const subagentCalls: Call[] = [
  ["Read", { file_path: `${REPO}/src/checkout/retry.ts` }],
  ["Read", { file_path: `${REPO}/src/checkout/provider.ts` }],
  ["Bash", { command: "npm test -- retry" }],
];

/** Tool rows exactly as the Claude adapter writes them into a session. */
function withToolCalls(session: Session): Session {
  let state = session;
  calls.forEach(([name, input], index) => {
    const callId = `toolu_${index}`;
    const agent = name === "Task";
    state = applyHarnessEvent(state, {
      type: "tool.started",
      callId,
      title: toolTitle(name, input),
      kind: toolKindFromName(name),
      status: agent ? "in_progress" : "pending",
      preview: previewFromTool(name, input),
    });
    if (agent) {
      subagentCalls.forEach(([stepName, stepInput], stepIndex) => {
        state = applyHarnessEvent(state, {
          type: "agent.step",
          callId,
          stepId: `${callId}_${stepIndex}`,
          kind: "tool",
          text: toolTitle(stepName, stepInput),
          toolKind: toolKindFromName(stepName),
          status: "completed",
          preview: previewFromTool(stepName, stepInput),
        });
      });
      return;
    }
    const printed =
      typeof input.command === "string" ? OUTPUT[input.command] : undefined;
    state = applyHarnessEvent(state, {
      type: "tool.updated",
      callId,
      title: toolTitle(name, input),
      kind: toolKindFromName(name),
      status: "completed",
      ...(printed ? { detail: printed } : {}),
      preview: previewFromTool(name, input, "ok"),
    });
  });
  return state;
}

function fixtureSession(): Session {
  const base: Session = {
    ...newSession("claude", PROJECT),
    id: "fixture",
    runtimeMode: "auto-accept-edits",
    branch: "fix/duplicate-charge",
    worktreeCwd: REPO,
    extraDirs: ["/home/dev/payments-sdk"],
    context: { used: 84_300, window: 200_000 },
  };
  const user: Block = {
    id: "user",
    role: "user",
    text: "Customers are sometimes charged twice at checkout. Find out why and fix it.",
    turnModel: { harness: "claude", id: base.model, name: "Claude" },
    attachments: [
      {
        id: "a1",
        name: "double-charge-receipt.png",
        mimeType: "image/png",
        kind: "image",
        size: 48_211,
      },
      {
        id: "a2",
        name: "provider-timeout.log",
        mimeType: "text/plain",
        kind: "file",
        size: 9_120,
        path: "/home/dev/Downloads/provider-timeout.log",
      },
      {
        id: "a3",
        name: "refund-thread.pdf",
        mimeType: "application/pdf",
        kind: "file",
        size: 120_400,
        path: "/home/dev/Downloads/refund-thread.pdf",
      },
    ],
  };
  const intro: Block = {
    id: "intro",
    role: "assistant",
    text: "I'll trace the charge request first, then make the retry safe.",
  };
  const tasks: Block = {
    id: "tasks",
    role: "tasks",
    text: "",
    taskList: { key: "fixture-tasks", items: steps },
  };
  const worked = withToolCalls({ ...base, blocks: [user, intro, tasks] });
  const said: Session = {
    ...worked,
    busy: true,
    blocks: [
      ...worked.blocks,
      {
        id: "progress",
        role: "assistant",
        text: "The charge request now carries an idempotency key. I'm making the timeout retry reuse it.",
      },
    ],
  };
  if (!RUNNING) return said;
  // Under what the agent last said: a command it has started and not finished,
  // printing as it goes.
  const input = { command: "npm test -- retry-timeout --runInBand" };
  let running = applyHarnessEvent(said, {
    type: "tool.started",
    callId: "toolu_running",
    title: toolTitle("Bash", input),
    kind: toolKindFromName("Bash"),
    status: "in_progress",
    preview: previewFromTool("Bash", input),
  });
  for (const printed of [
    " RUN  v3.2.7 /home/dev/storefront\n\n",
    " ✓ retries once on a timeout 48ms\n",
  ]) {
    running = applyHarnessEvent(running, {
      type: "tool.updated",
      callId: "toolu_running",
      kind: "execute",
      status: "in_progress",
      detail: printed,
      append: true,
    });
  }
  return running;
}

const initial = fixtureSession();

/** The same session with the agent `count` steps further down its list. */
function advanced(session: Session, count: number): Session {
  return {
    ...session,
    blocks: session.blocks.map((block) => {
      if (!block.taskList) return block;
      const items = block.taskList.items;
      const running = items.findIndex((item) => item.status === "in_progress");
      const next = Math.min(items.length - 1, running + count);
      return {
        ...block,
        taskList: {
          ...block.taskList,
          items: items.map((item, index) => ({
            ...item,
            status:
              index < next
                ? "completed"
                : index === next
                  ? "in_progress"
                  : "pending",
          })),
        },
      };
    }),
  };
}

/** What the panel asked the app to do, for the spec to read back. */
const asked: { opened: string[]; shown: string[] } = { opened: [], shown: [] };
(window as unknown as { __panel: typeof asked }).__panel = asked;
function record(kind: keyof typeof asked, value: string) {
  asked[kind].push(value);
}

/** The pane's layout, cut down to what the panel sits beside. */
function Fixture() {
  const [session, setSession] = useState(initial);
  useEffect(() => {
    (window as unknown as { __advance: (count: number) => void }).__advance = (
      count,
    ) => setSession((current) => advanced(current, count));
  }, []);
  const panel = useSessionPanel(sessionHasPanel(session, false), session);
  const navigate = useRef<((blockId: string | null) => boolean) | null>(null);
  const onNavigateReady = useCallback(
    (ready: (blockId: string | null) => boolean) => {
      navigate.current = ready;
    },
    [],
  );
  const showInChat = (blockId: string) => {
    record("shown", blockId);
    navigate.current?.(blockId);
  };
  return (
    <div className="chat-pane-background flex h-full min-h-0 min-w-0 flex-col">
      {/* The window's title bar, cut down to the slot the pane's button fills. */}
      <header
        data-fixture-title-bar
        className="flex h-10 shrink-0 items-stretch justify-end border-b border-stroke"
      >
        <SessionPanelSlot />
      </header>
      <SessionPanelToggle panel={panel} place="title-bar" />
      <div ref={panel.paneRef} className="flex min-h-0 min-w-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            data-fixture-transcript
            className="@container relative min-h-0 flex-1"
          >
            <AgentTranscript
              blocks={session.blocks}
              busy={!!session.busy}
              visible
              cwd={session.worktreeCwd}
              harness={session.harness}
              model={session.model}
              onNavigateReady={onNavigateReady}
            />
          </div>
          {/* Where the pane docks its composer: in the transcript's column. */}
          <div
            data-fixture-composer
            className="mx-3 mb-3 h-14 shrink-0 rounded-xl border border-content/10 bg-content/5"
          />
        </div>
        <SessionPanel
          panel={panel}
          session={session}
          onOpenFile={(path) => record("opened", path)}
          onShowInChat={showInChat}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
