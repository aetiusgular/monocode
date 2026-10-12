import { useMemo, useRef, useState } from "react";
import {
  Check,
  Loader,
  MessageSquarePlus,
  Search,
  X,
} from "../../../shared/ui/icons";
import {
  canRunHelper,
  type HelperTarget,
} from "../../../integrations/harness/core/helperPrompt";
import { harnessCan } from "../../../integrations/harness/core/capabilities";
import { isHarnessAvailable } from "../../../integrations/harness/core/availability";
import { HARNESS_TITLE, type HarnessId } from "../../sessions/model/session";
import { requestAddToChat } from "../../sessions/model/quoteDraft";
import { formatFindingForChat, type ReviewFinding } from "../model/findings";
import {
  asRoute,
  reviewerLocality,
  runReview,
  type ReviewProgress,
  type ReviewResult,
} from "../model/runReview";
import { recordReviewConsent, reviewNeedsConsent } from "../model/reviewConsent";

/** Harnesses offered as a reviewer besides the session's own route. */
const OTHER_REVIEWERS: HarnessId[] = ["claude", "codex", "cursor", "grok", "opencode"];

export type ReviewerChoice = {
  id: string;
  label: string;
  target: HelperTarget;
  locality: "local" | "hosted" | "unknown";
};

/**
 * The reviewers on offer: the session that owns the checkout first, then
 * each installed harness that can run a side prompt, on its default account.
 */
export function reviewerChoices(
  owner: HelperTarget | undefined,
  available: (harness: HarnessId) => boolean = (harness) =>
    isHarnessAvailable(harness) && harnessCan(harness, "textPrompt"),
): ReviewerChoice[] {
  const choices: ReviewerChoice[] = [];
  if (owner) {
    const route = asRoute(owner);
    choices.push({
      id: "owner",
      label: `This session (${HARNESS_TITLE[route.harness]})`,
      target: owner,
      locality: reviewerLocality(owner),
    });
  }
  for (const harness of OTHER_REVIEWERS) {
    if (!available(harness)) continue;
    choices.push({
      id: harness,
      label: `${HARNESS_TITLE[harness]}, default account`,
      target: harness,
      locality: reviewerLocality(harness),
    });
  }
  return choices;
}

function localityWord(locality: ReviewerChoice["locality"]): string {
  return locality === "local" ? "local" : "hosted";
}

/**
 * #32: review the working tree with a model you pick. Findings land as
 * comments tied to diff lines, each with "Send to chat".
 */
export function ReviewSection({
  cwd,
  owner,
  hasChanges,
  onOpenPath,
}: {
  cwd: string;
  owner?: HelperTarget;
  hasChanges: boolean;
  onOpenPath?: (relative: string) => void;
}) {
  const choices = useMemo(() => reviewerChoices(owner), [owner]);
  const [open, setOpen] = useState(false);
  const [choiceId, setChoiceId] = useState<string>();
  const [asking, setAsking] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ReviewProgress>();
  const [result, setResult] = useState<ReviewResult>();
  const [error, setError] = useState<string>();
  const abort = useRef<AbortController | null>(null);
  const choice = choices.find((entry) => entry.id === choiceId) ?? choices[0];

  const start = async (confirmed = false) => {
    if (!choice || running) return;
    if (
      !confirmed &&
      reviewNeedsConsent({ project: cwd, owner, reviewer: choice.target })
    ) {
      setAsking(true);
      return;
    }
    if (confirmed) recordReviewConsent(cwd);
    setAsking(false);
    setError(undefined);
    setResult(undefined);
    setRunning(true);
    const controller = new AbortController();
    abort.current = controller;
    try {
      setResult(
        await runReview({
          cwd,
          reviewer: choice.target,
          signal: controller.signal,
          onProgress: setProgress,
        }),
      );
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      if (abort.current === controller) abort.current = null;
      setRunning(false);
      setProgress(undefined);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        data-code-review-open
        disabled={!hasChanges || choices.length === 0}
        title={
          choices.length === 0
            ? "No agent here can review on the side"
            : "Review the uncommitted changes with a model"
        }
        onClick={() => setOpen(true)}
        className="mt-1.5 flex h-7 w-full items-center justify-center gap-1.5 rounded-md bg-content/10 text-[12px] text-content hover:bg-content/15 disabled:opacity-40"
      >
        <Search className="size-3.5" strokeWidth={1.75} />
        Review changes
      </button>
    );
  }

  const findings = result?.findings ?? [];
  return (
    <section
      data-code-review
      aria-label="Code review"
      className="mt-1.5 rounded-md border border-content/10 bg-content/3 p-2 text-[12px]"
    >
      <div className="flex items-center gap-1.5">
        <select
          aria-label="Reviewer"
          value={choice?.id ?? ""}
          disabled={running}
          onChange={(event) => {
            setChoiceId(event.target.value);
            setAsking(false);
          }}
          className="h-7 min-w-0 flex-1 rounded-md bg-content/10 px-1.5 text-[12px] text-content outline-none"
        >
          {choices.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label} · {localityWord(entry.locality)}
            </option>
          ))}
        </select>
        {running ? (
          <button
            type="button"
            onClick={() => abort.current?.abort()}
            className="flex h-7 items-center gap-1 rounded-md bg-content/10 px-2 text-content hover:bg-content/20"
          >
            <X className="size-3.5" /> Stop
          </button>
        ) : (
          <button
            type="button"
            disabled={!choice || !canRunHelper(asRoute(choice.target))}
            onClick={() => void start()}
            className="flex h-7 items-center gap-1 rounded-md bg-content px-2 font-medium text-background-base disabled:opacity-40"
          >
            Review
          </button>
        )}
        <button
          type="button"
          aria-label="Close review"
          onClick={() => {
            abort.current?.abort();
            setOpen(false);
          }}
          className="grid size-7 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {asking && choice ? (
        <div role="alertdialog" aria-label="Send the diff" className="mt-2 rounded-md bg-amber-400/10 p-2 text-content/80">
          <p>
            The diff of this project goes to {choice.label}, a hosted model, not to this session's own model.
          </p>
          <div className="mt-1.5 flex gap-1.5">
            <button
              type="button"
              onClick={() => void start(true)}
              className="h-6 rounded-md bg-content px-2 text-background-base"
            >
              Send it, and don't ask again for this project
            </button>
            <button
              type="button"
              onClick={() => setAsking(false)}
              className="h-6 rounded-md bg-content/10 px-2 text-content"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {running ? (
        <p className="mt-2 flex items-center gap-1.5 text-content/55">
          <Loader className="size-3.5 animate-spin" />
          {progress && progress.total > 1
            ? `Reviewing part ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
            : "Reviewing…"}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-red-400">
          {error}
        </p>
      ) : null}
      {result ? <ReviewFindings result={result} findings={findings} onOpenPath={onOpenPath} /> : null}
    </section>
  );
}

function ReviewFindings({
  result,
  findings,
  onOpenPath,
}: {
  result: ReviewResult;
  findings: ReviewFinding[];
  onOpenPath?: (relative: string) => void;
}) {
  const [sent, setSent] = useState<ReadonlySet<number>>(new Set());
  const send = (indexes: number[]) => {
    for (const index of indexes) requestAddToChat(formatFindingForChat(findings[index]), "plain");
    setSent((prior) => new Set([...prior, ...indexes]));
  };
  const notes: string[] = [];
  if (result.files === 0) notes.push("No uncommitted changes to review.");
  else if (findings.length === 0 && result.failures.length === 0) notes.push("No findings.");
  if (result.dropped > 0) {
    notes.push(
      `${result.dropped} finding${result.dropped === 1 ? " was" : "s were"} about files not in the diff and ${result.dropped === 1 ? "was" : "were"} dropped.`,
    );
  }
  if (result.truncated) notes.push("The diff was cut to fit; the end was not reviewed.");
  if (result.skipped.length > 0) {
    notes.push(`Not reviewed: ${result.skipped.slice(0, 5).join(", ")}${result.skipped.length > 5 ? ` and ${result.skipped.length - 5} more` : ""}.`);
  }
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {findings.length > 1 ? (
        <button
          type="button"
          onClick={() => send(findings.map((_, index) => index))}
          className="flex h-6 items-center gap-1 self-end rounded-md bg-content/10 px-2 text-content hover:bg-content/20"
        >
          <MessageSquarePlus className="size-3.5" /> Send all to chat
        </button>
      ) : null}
      <ul aria-label="Review findings" className="flex flex-col gap-1.5">
        {findings.map((finding, index) => {
          const location = finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
          return (
            <li key={`${location}:${index}`} data-review-finding className="rounded-md bg-content/5 p-1.5">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={!onOpenPath}
                  onClick={() => onOpenPath?.(finding.path)}
                  className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-content/60 hover:text-content"
                  title={finding.movedToFile ? `${location} (the model named a line the diff does not show)` : location}
                >
                  {location}
                </button>
                <button
                  type="button"
                  aria-label={`Send ${location} to chat`}
                  onClick={() => send([index])}
                  className="flex h-5 shrink-0 items-center gap-1 rounded px-1 text-[11px] text-content/60 hover:bg-content/10 hover:text-content"
                >
                  {sent.has(index) ? <Check className="size-3" /> : <MessageSquarePlus className="size-3" />}
                  Send to chat
                </button>
              </div>
              {finding.quote !== undefined ? (
                <pre className="mt-1 truncate rounded bg-content/5 px-1 font-mono text-[11px] text-content/50">{finding.quote}</pre>
              ) : null}
              <p className="mt-1 whitespace-pre-wrap text-content/85">{finding.comment}</p>
            </li>
          );
        })}
      </ul>
      {result.failures.map((failure) => (
        <p key={failure} className="text-[11px] text-red-400">
          Not reviewed: {failure}
        </p>
      ))}
      {notes.map((note) => (
        <p key={note} className="text-[11px] text-content/45">
          {note}
        </p>
      ))}
    </div>
  );
}
