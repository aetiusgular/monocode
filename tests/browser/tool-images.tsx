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
} from "../../src/features/sessions/model/session";
import { AgentTranscript } from "../../src/features/sessions/ui/AgentTranscript";
import {
  saveTranscriptAnchor,
  saveTranscriptLayout,
} from "../../src/features/settings/model/appearance";
import { ToolImageGalleryHost } from "../../src/features/tool-images";
import { keepToolResultImages } from "../../src/features/tool-images/data/toolImageStore";
import { applyHarnessEvent } from "../../src/integrations/harness/core/apply";
import type { HarnessEvent } from "../../src/integrations/harness/core/types";
import {
  previewFromTool,
  toolKindFromName,
  toolResultsFromUserMessage,
  toolTitle,
} from "../../src/integrations/harness/providers/claude/claudeProtocol";
import "../../src/styles/index.css";

saveTranscriptAnchor(false);
saveTranscriptLayout("chat");

const PROJECT = "/home/dev/storefront";
const PARAMS = new URLSearchParams(location.search);
/** A session whose tool calls returned text only. */
const NO_IMAGES = PARAMS.get("images") === "0";
/** End with a subagent that takes two screenshots of its own. */
const AGENT = PARAMS.get("agent") === "1";

/**
 * The app's side of the image store, kept in memory: the generated-image
 * folder, which like the real one takes PNG and nothing else.
 */
const disk = new Map<string, Uint8Array>();
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
(
  window as unknown as {
    __TAURI_INTERNALS__: {
      invoke: (
        command: string,
        args?: Record<string, unknown>,
      ) => Promise<unknown>;
    };
  }
).__TAURI_INTERNALS__ = {
  invoke: async (command, args) => {
    if (command === "save_generated_image") {
      const bytes = Uint8Array.from(atob(String(args?.data)), (char) =>
        char.charCodeAt(0),
      );
      if (!PNG.every((byte, index) => bytes[index] === byte)) {
        throw new Error("Generated image data is not a PNG image.");
      }
      const path = `/app-data/generated-images/${disk.size + 1}-${String(args?.name)}.png`;
      disk.set(path, bytes);
      return { path, mimeType: "image/png", size: bytes.byteLength };
    }
    if (command === "read_binary_file") {
      const bytes = disk.get(String(args?.path));
      if (!bytes) throw new Error("No such file.");
      return bytes.slice().buffer;
    }
    if (command === "delete_generated_images") {
      for (const path of (args?.paths as string[]) ?? []) disk.delete(path);
      return undefined;
    }
    throw new Error(`The fixture has no ${command}.`);
  },
};
(window as unknown as { __disk: () => string[] }).__disk = () => [
  ...disk.keys(),
];

/** A drawn stand-in for a screenshot: a page with a numbered heading. */
function screenshot(
  number: number,
  type: "image/png" | "image/jpeg" = "image/png",
) {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 400;
  const context = canvas.getContext("2d")!;
  context.fillStyle = `hsl(${(number * 47) % 360} 55% 92%)`;
  context.fillRect(0, 0, 640, 400);
  context.fillStyle = `hsl(${(number * 47) % 360} 60% 40%)`;
  context.fillRect(0, 0, 640, 56);
  context.fillStyle = "#1c1c1c";
  context.font = "600 40px sans-serif";
  context.fillText(`Screenshot ${number}`, 32, 140);
  context.fillStyle = "#00000022";
  for (let row = 0; row < 4; row++) {
    context.fillRect(32, 180 + row * 44, 420 - row * 60, 20);
  }
  const url = canvas.toDataURL(type);
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: type,
      data: url.slice(url.indexOf(",") + 1),
    },
  };
}

type Call = {
  name: string;
  input: Record<string, unknown>;
  /** The tool result's content, as Claude Code's stream carries it. */
  content: unknown;
};

const SHOT = "mcp__playwright__browser_take_screenshot";

function fixtureCalls(): Call[] {
  return [
    {
      name: "mcp__playwright__browser_navigate",
      input: { url: "http://localhost:5173/checkout" },
      content: "Navigated to http://localhost:5173/checkout",
    },
    {
      name: SHOT,
      input: {},
      content: NO_IMAGES
        ? "Took the screenshot."
        : [{ type: "text", text: "Took the screenshot." }, screenshot(1)],
    },
    {
      name: "Read",
      input: { file_path: `${PROJECT}/design/checkout-mock.jpg` },
      // A JPEG, which has to be drawn again as PNG before it can be kept.
      content: NO_IMAGES ? "Read the file." : [screenshot(2, "image/jpeg")],
    },
    {
      name: SHOT,
      input: { fullPage: true },
      content: NO_IMAGES
        ? "Took the screenshots."
        : [3, 4, 5, 6, 7, 8].map((number) => screenshot(number)),
    },
    {
      name: "Bash",
      input: { command: "npm test -- checkout" },
      content: " Test Files  1 passed (1)\n      Tests  14 passed (14)",
    },
  ];
}

/**
 * One tool call the way the Claude adapter reports it: the row, its result,
 * and then the images of that result once the store has saved them.
 */
async function runCall(
  session: Session,
  callId: string,
  call: Call,
): Promise<Session> {
  let state = applyHarnessEvent(session, {
    type: "tool.started",
    callId,
    title: toolTitle(call.name, call.input),
    kind: toolKindFromName(call.name),
    status: "pending",
    preview: previewFromTool(call.name, call.input),
  });
  const [result] = toolResultsFromUserMessage({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: callId, content: call.content },
      ],
    },
  });
  state = applyHarnessEvent(state, {
    type: "tool.updated",
    callId,
    title: toolTitle(call.name, call.input),
    kind: toolKindFromName(call.name),
    status: "completed",
    detail: result.text || undefined,
    preview: previewFromTool(call.name, call.input, result.text),
  });
  const events: HarnessEvent[] = [];
  await keepToolResultImages({
    sessionId: session.id,
    callId,
    sourceId: result.toolUseId,
    images: result.images ?? [],
    emit: (event) => events.push(event),
  });
  for (const event of events) state = applyHarnessEvent(state, event);
  return state;
}

/**
 * A subagent whose own tool calls return images, as the Claude adapter
 * reports it: each inner call is a step on the Agent row, and its images go
 * on that row too.
 */
async function runSubagent(session: Session, callId: string): Promise<Session> {
  const input = {
    description: "Check the mobile layout",
    subagent_type: "general-purpose",
  };
  let state = applyHarnessEvent(session, {
    type: "tool.started",
    callId,
    title: toolTitle("Task", input),
    kind: toolKindFromName("Task"),
    status: "in_progress",
    preview: previewFromTool("Task", input),
  });
  for (const [index, number] of [9, 10].entries()) {
    const stepId = `${callId}_step_${index}`;
    state = applyHarnessEvent(state, {
      type: "agent.step",
      callId,
      stepId,
      kind: "tool",
      text: toolTitle(SHOT, {}),
      toolKind: toolKindFromName(SHOT),
      status: "completed",
    });
    const events: HarnessEvent[] = [];
    await keepToolResultImages({
      sessionId: session.id,
      callId,
      sourceId: stepId,
      images: [
        {
          data: screenshot(number).source.data,
          mimeType: "image/png",
        },
      ],
      emit: (event) => events.push(event),
    });
    for (const event of events) state = applyHarnessEvent(state, event);
  }
  return state;
}

async function fixtureSession(): Promise<Session> {
  const base: Session = {
    ...newSession("claude", PROJECT),
    id: "fixture",
    runtimeMode: "auto-accept-edits",
  };
  const user: Block = {
    id: "user",
    role: "user",
    text: "Check that the checkout page matches the mock, step by step.",
    turnModel: { harness: "claude", id: base.model, name: "Claude" },
  };
  const intro: Block = {
    id: "intro",
    role: "assistant",
    text: "I'll open the page and compare it with the mock.",
  };
  let state: Session = { ...base, blocks: [user, intro] };
  for (const [index, call] of fixtureCalls().entries()) {
    state = await runCall(state, `toolu_${index}`, call);
  }
  if (AGENT) state = await runSubagent(state, "toolu_agent");
  return {
    ...state,
    busy: true,
    blocks: [
      ...state.blocks,
      {
        id: "progress",
        role: "assistant",
        text: "The first steps match the mock. I'm checking the payment step next.",
      },
    ],
  };
}

/** The pane's layout, cut down to what the images show up in. */
function Fixture({ initial }: { initial: Session }) {
  const [session, setSession] = useState(initial);
  const latest = useRef(session);
  latest.current = session;
  useEffect(() => {
    let taken = 8;
    // The agent takes one more screenshot while the turn runs.
    (window as unknown as { __shoot: () => Promise<void> }).__shoot =
      async () => {
        taken += 1;
        const next = await runCall(latest.current, `toolu_live_${taken}`, {
          name: SHOT,
          input: { element: `Payment step ${taken}` },
          content: [screenshot(taken)],
        });
        setSession(next);
      };
  }, []);
  const panel = useSessionPanel(sessionHasPanel(session, false), session);
  const navigate = useRef<((blockId: string | null) => boolean) | null>(null);
  const onNavigateReady = useCallback(
    (ready: (blockId: string | null) => boolean) => {
      navigate.current = ready;
    },
    [],
  );
  return (
    <div className="chat-pane-background flex h-full min-h-0 min-w-0 flex-col">
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
              cwd={session.cwd}
              harness={session.harness}
              model={session.model}
              onNavigateReady={onNavigateReady}
            />
          </div>
        </div>
        <SessionPanel
          panel={panel}
          session={session}
          onOpenFile={() => undefined}
          onShowInChat={(blockId) => navigate.current?.(blockId)}
        />
        <ToolImageGalleryHost blocks={session.blocks} cwd={session.cwd} />
      </div>
    </div>
  );
}

void fixtureSession().then((initial) => {
  createRoot(document.getElementById("root")!).render(
    <Fixture initial={initial} />,
  );
});
