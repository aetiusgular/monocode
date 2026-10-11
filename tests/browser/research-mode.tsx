import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  researchReportPath,
  researchTurnPrompt,
} from "../../src/features/research-mode/model/researchPrompt";
import {
  researchRequest,
  researchTools,
} from "../../src/features/research-mode/model/searchTools";
import { researchMenuState } from "../../src/features/research-mode/model/visibility";
import { ResearchChip } from "../../src/features/research-mode/ui/ResearchChip";
import { ResearchMenuItem } from "../../src/features/research-mode/ui/ResearchMenuItem";
import type {
  Block,
  HarnessId,
} from "../../src/features/sessions/model/session";
import {
  saveTranscriptAnchor,
  saveTranscriptLayout,
} from "../../src/features/settings/model/appearance";
import { TranscriptWithApprovalRules } from "../../src/features/tool-access/ui/TranscriptWithApprovalRules";
import { Popover } from "../../src/shared/ui/Popover";
import "../../src/styles/index.css";

saveTranscriptAnchor(false);
saveTranscriptLayout("chat");

/**
 * `?search=none`: a Codex chat with no gateway search connector, which has no
 * search tool. Otherwise a Claude Code chat with the built-in WebSearch and
 * WebFetch and a Docker gateway Exa connector.
 */
const NO_SEARCH = new URLSearchParams(location.search).get("search") === "none";
const HARNESS: HarnessId = NO_SEARCH ? "codex" : "claude";

/** What the page sent to the harness and asked the app to open. */
const asked: { prompts: string[]; opened: string[] } = {
  prompts: [],
  opened: [],
};
(window as unknown as { __research: typeof asked }).__research = asked;

/** The composer cut down to its plus menu, the chip, the input and Send. */
function Fixture() {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [plusOpen, setPlusOpen] = useState(false);
  const [selected, setSelected] = useState(false);
  const [draft, setDraft] = useState("");
  const plus = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const tools = useMemo(
    () =>
      researchTools({
        harness: HARNESS,
        gateway: NO_SEARCH
          ? []
          : [{ sessionName: "exa", title: "Exa", server: "exa" }],
      }),
    [],
  );
  const state = researchMenuState({ harness: HARNESS, remote: false, tools });
  const active = selected && state !== "hidden";
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    const request = active
      ? researchRequest(tools, { harness: HARNESS }, researchReportPath(text))
      : undefined;
    asked.prompts.push(request ? researchTurnPrompt(text, request) : text);
    setBlocks((current) => [
      ...current,
      {
        id: `u${current.length}`,
        role: "user",
        text,
        ...(request ? { research: true as const } : {}),
      },
    ]);
    setDraft("");
    setSelected(false);
  };
  return (
    <div className="flex h-full min-h-0 flex-col bg-background-base text-content">
      <div className="flex min-h-0 flex-1 flex-col">
        <TranscriptWithApprovalRules
          approvalRules={null}
          blocks={blocks}
          busy={false}
          cwd="/home/dev/notes"
          harness={HARNESS}
        />
      </div>
      <div
        data-composer
        className="mx-3 mb-3 rounded-xl border border-content/15 bg-content/5"
      >
        {active ? (
          <ResearchChip
            canSearch={state === "ready"}
            onClear={() => {
              setSelected(false);
              input.current?.focus();
            }}
          />
        ) : null}
        <textarea
          ref={input}
          aria-label="Message input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          className="w-full resize-none bg-transparent px-3 py-3 text-sm outline-none"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <div ref={plus} className="relative shrink-0">
            <button
              type="button"
              aria-label="Add files or choose a mode"
              onClick={() => setPlusOpen((open) => !open)}
              className="grid size-6.5 place-items-center rounded-md bg-content/10 text-[13px]"
            >
              +
            </button>
            {plusOpen && state !== "hidden" ? (
              <Popover
                anchor={plus}
                side="top"
                align="start"
                width={250}
                onDismiss={() => setPlusOpen(false)}
                data-composer-plus
                className="p-1.5"
              >
                <ResearchMenuItem
                  state={state}
                  active={active}
                  onToggle={() => {
                    setSelected(!active);
                    setPlusOpen(false);
                    input.current?.focus();
                  }}
                  onOpenConnectors={() => {
                    asked.opened.push("connectors:discover");
                    setPlusOpen(false);
                  }}
                />
              </Popover>
            ) : null}
          </div>
          <button
            type="button"
            onClick={send}
            className="ml-auto rounded-md bg-content/10 px-2 py-1 text-[12px]"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
