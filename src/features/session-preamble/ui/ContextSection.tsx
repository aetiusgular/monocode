import { useCallback, useEffect, useState } from "react";
import { PanelSection } from "../../session-panel/ui/PanelSection";
import {
  chatContextPrefs,
  preambleReport,
  setChatMemoryOff,
  useChatContextVersion,
  type PreambleReport,
} from "../model/chatContext";
import { CHARS_PER_TOKEN } from "../model/preamble";
import { resendPreamble } from "../model/sessionPreamble";
import {
  acceptProposal,
  loadProposals,
  rejectProposal,
  type MemoryProposal,
} from "../../project-memory/model/proposals";
import {
  suggestMemories,
  type SuggestSession,
} from "../../project-memory/model/suggest";
import {
  readGlobalContext,
  readProjectContext,
  subscribeProjectContext,
} from "../../project-context/model/projectContext";

const CHANNEL_TEXT: Record<PreambleReport["channel"], string> = {
  message: "Sent ahead of the last message",
  native: "Given at launch",
  unchanged: "Already with the agent",
  none: "Nothing to send",
};

export function preambleSummary(report: PreambleReport | undefined): string {
  if (!report) return "Nothing sent yet in this run of the app";
  const size = `${report.chars.toLocaleString("en-US")} of ${report.budget.toLocaleString(
    "en-US",
  )} characters, about ${Math.ceil(report.chars / CHARS_PER_TOKEN).toLocaleString("en-US")} tokens`;
  return report.channel === "none"
    ? CHANNEL_TEXT.none
    : `${CHANNEL_TEXT[report.channel]}. ${size}.`;
}

export function omittedLines(report: PreambleReport | undefined): string[] {
  return (report?.omitted ?? []).map((entry) =>
    entry.lines
      ? `${entry.label}: ${entry.lines} ${entry.lines === 1 ? "entry" : "entries"} did not fit`
      : `${entry.label} did not fit`,
  );
}

type ViewProps = {
  report: PreambleReport | undefined;
  memoryOff: boolean;
  proposals: readonly MemoryProposal[];
  resent: boolean;
  onMemoryOff: (off: boolean) => void;
  onResend: () => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  /** Absent when the chat cannot suggest (no session, memory off). */
  onSuggest?: () => void;
  suggesting?: boolean;
  suggestNote?: string;
};

/**
 * What MonoCode tells the agent for this chat (F2), what did not fit the
 * model's budget, the per-chat memory switch (#36) and memory waiting for the
 * user's click.
 */
export function ContextSectionView({
  report,
  memoryOff,
  proposals,
  resent,
  onMemoryOff,
  onResend,
  onAccept,
  onReject,
  onSuggest,
  suggesting = false,
  suggestNote,
}: ViewProps) {
  const omitted = omittedLines(report);
  return (
    <PanelSection title="Context" fold="context">
      <div
        data-context-section
        className="flex flex-col gap-1.5 px-2 text-[12px]"
      >
        <p data-context-summary className="text-content/70">
          {preambleSummary(report)}
        </p>
        {report?.overBudget ? (
          <p data-context-over className="text-amber-600 dark:text-amber-400">
            App access alone is over this model's budget.
          </p>
        ) : null}
        {omitted.length ? (
          <ul data-context-omitted className="list-disc pl-4 text-content/60">
            {omitted.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        <label className="flex items-center gap-2 text-content/80">
          <input
            type="checkbox"
            data-context-memory
            checked={!memoryOff}
            onChange={(event) => onMemoryOff(!event.currentTarget.checked)}
          />
          Use project memory in this chat
        </label>
        <button
          type="button"
          data-context-resend
          className="self-start rounded-md px-2 py-1 text-content/75 hover:bg-content/8 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          onClick={onResend}
        >
          {resent ? "Goes with the next message" : "Send instructions again"}
        </button>
        {onSuggest && !memoryOff ? (
          <button
            type="button"
            data-context-suggest
            disabled={suggesting}
            className="self-start rounded-md px-2 py-1 text-content/75 hover:bg-content/8 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            onClick={onSuggest}
          >
            {suggesting
              ? "Asking the chat's model…"
              : "Suggest memories from this chat"}
          </button>
        ) : null}
        {suggestNote ? (
          <p data-context-suggest-note className="text-content/55">
            {suggestNote}
          </p>
        ) : null}
        {proposals.length ? (
          <div data-context-proposals className="flex flex-col gap-1">
            <p className="text-content/55">Memory waiting for you</p>
            {proposals.map((proposal) => (
              <div
                key={proposal.id}
                data-context-proposal={proposal.id}
                className="rounded-md bg-content/5 px-2 py-1.5"
              >
                <p className="text-content/85">
                  {proposal.fact}
                  {proposal.local ? (
                    <span className="ml-1 text-content/45">(local only)</span>
                  ) : null}
                </p>
                <div className="mt-1 flex gap-1">
                  <button
                    type="button"
                    data-proposal-accept
                    className="rounded px-1.5 py-0.5 text-content/80 hover:bg-content/10"
                    onClick={() => onAccept(proposal.id)}
                  >
                    Remember
                  </button>
                  <button
                    type="button"
                    data-proposal-reject
                    className="rounded px-1.5 py-0.5 text-content/55 hover:bg-content/10"
                    onClick={() => onReject(proposal.id)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </PanelSection>
  );
}

/**
 * Shown once there is something to show: text MonoCode sends, a report of
 * the last turn, or memory waiting. A project with no instructions, notes or
 * memory has nothing to manage here.
 */
export function ContextSection({
  sessionId,
  project,
  session,
}: {
  sessionId: string;
  project: string | undefined;
  /** The chat itself, for Suggest memories. */
  session?: SuggestSession;
}) {
  const [suggesting, setSuggesting] = useState(false);
  const [suggestNote, setSuggestNote] = useState<string>();
  useChatContextVersion();
  const [proposals, setProposals] = useState<MemoryProposal[]>([]);
  const [hasContext, setHasContext] = useState(false);
  const [resent, setResent] = useState(false);
  const refresh = useCallback(() => {
    void (async () => {
      const read = async (load: () => Promise<{ text: string | null }>) => {
        try {
          return !!(await load()).text?.trim();
        } catch {
          return false;
        }
      };
      const found = await Promise.all([
        read(() => readGlobalContext("instructions.md")),
        ...(project
          ? [
              read(() => readProjectContext(project, "notes.md")),
              read(() => readProjectContext(project, "MEMORY.md")),
            ]
          : []),
      ]);
      setHasContext(found.some(Boolean));
      if (!project) return setProposals([]);
      const list = await loadProposals(project).catch(
        () => [] as MemoryProposal[],
      );
      setProposals(list.slice(-10));
    })();
  }, [project]);
  useEffect(() => {
    refresh();
    return subscribeProjectContext(refresh);
  }, [refresh]);
  useEffect(() => {
    setResent(false);
    setSuggestNote(undefined);
  }, [sessionId]);
  const report = preambleReport(sessionId);
  const memoryOff = chatContextPrefs(sessionId).memoryOff === true;
  if (!hasContext && !report?.chars && !proposals.length && !memoryOff)
    return null;
  return (
    <ContextSectionView
      report={report}
      memoryOff={memoryOff}
      proposals={proposals}
      resent={resent}
      onMemoryOff={(off) => setChatMemoryOff(sessionId, off)}
      onResend={() => {
        resendPreamble(sessionId);
        setResent(true);
      }}
      onAccept={(id) => {
        if (project) void acceptProposal(project, id).finally(refresh);
      }}
      onReject={(id) => {
        if (project) void rejectProposal(project, id).finally(refresh);
      }}
      suggesting={suggesting}
      suggestNote={suggestNote}
      onSuggest={
        session
          ? () => {
              setSuggesting(true);
              setSuggestNote(undefined);
              void suggestMemories(session)
                .then((result) =>
                  setSuggestNote(
                    !result.ok
                      ? result.reason
                      : result.proposals.length
                        ? `${result.proposals.length} waiting below.`
                        : "Nothing new worth remembering.",
                  ),
                )
                .finally(() => {
                  setSuggesting(false);
                  refresh();
                });
            }
          : undefined
      }
    />
  );
}
