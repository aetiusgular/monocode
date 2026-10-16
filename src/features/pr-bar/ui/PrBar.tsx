import { useEffect, useRef, useState } from "react";
import { GitPullRequest, Loader } from "../../../shared/ui/icons";
import {
  fetchGithubPrChecks,
  summarizePrChecks,
  type GithubPrChecks,
} from "../../inbox/model/githubPrChecks";
import { buildCiRepairRequest } from "../../inbox/model/ciRepair";
import {
  isHelperRoute,
  type HelperTarget,
} from "../../../integrations/harness/core/helperPrompt";
import { setPrAutoMerge } from "../data/prAuto";
import {
  autoFixWarning,
  autoMergeRefusalText,
  autoMergeView,
  checksStateFor,
  decideAutoFix,
  MAX_FIX_ATTEMPTS,
  prBarHost,
  prBarState,
  prRefFromUrl,
  savePrBarSettings,
  shouldAutoArchive,
  usePrBarSettings,
  type MergeMethod,
  type PrChecksRead,
  type PrRef,
} from "../model/prBar";
import {
  lastCheckedText,
  lookupFailedText,
} from "../../source-control/model/prLookup";
import { useOutboundCallAllowed } from "../../settings/model/outboundCalls";

/**
 * How often the bar re-reads the PR while auto-fix or auto-merge is on. GitHub
 * clears auto-merge by itself after some pushes and base changes, and the
 * switch shows what GitHub reports.
 */
export const CHECK_POLL_MS = 60_000;

type Pr = { number: number; url: string; state: string };

function Switch({
  label,
  on,
  disabled,
  onChange,
}: {
  label: string;
  on: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors disabled:opacity-40 ${on ? "bg-accent" : "bg-content/20"}`}
    >
      <span
        className={`absolute top-0.5 size-3 rounded-full bg-white transition-[left] ${on ? "left-3.5" : "left-0.5"}`}
      />
    </button>
  );
}

/**
 * #33: the PR bar under the changes panel, for a GitHub pull request of the
 * checked-out branch. Auto-merge goes through GitHub; auto-archive and
 * auto-fix act on the chat that owns the checkout.
 */
export function PrBar({
  cwd,
  pr,
  owner,
  stale = false,
  confirmed = true,
  checkedAt = null,
  reloadPr,
  initialChecks = null,
}: {
  cwd: string;
  pr: Pr;
  owner?: HelperTarget;
  /** The PR lookup failed; this is the last known PR (4.10). Switches are off. */
  stale?: boolean;
  /**
   * A lookup in this app run answered for this PR. Until then the PR may be
   * a cached one, and the switches are off (review of the 15 Oct pass, G4).
   */
  confirmed?: boolean;
  checkedAt?: number | null;
  /**
   * Run the PR lookup again: after Check now (J1), and, with "GitHub
   * lookups" on, when GitHub reports the PR merged or closed while the
   * lookup still says otherwise (4.10, K7).
   */
  reloadPr?: () => void;
  /** Test seam: checks to show before the first read. */
  initialChecks?: GithubPrChecks | null;
}) {
  const ref: PrRef | null = prRefFromUrl(pr.url);
  const settings = usePrBarSettings(ref);
  const route = isHelperRoute(owner) ? owner : undefined;
  const sessionId = route?.sessionId;
  // The latest checks, with the PR number they were read for and when.
  const [read, setRead] = useState<PrChecksRead>(() => ({
    checks: initialChecks,
    number: initialChecks ? (ref?.number ?? null) : null,
    at: null,
  }));
  const checks = read.checks;
  const setChecks = (next: GithubPrChecks, number: number) =>
    setRead({ checks: next, number, at: Date.now() });
  const [checksError, setChecksError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const [reads, setReads] = useState(0);
  // "GitHub lookups" off: the bar reads nothing on its own, only after you
  // press Check now or change auto-merge (5.9; review of the 15 Oct pass, G2),
  // and once for each of those (K7).
  const lookupsOn = useOutboundCallAllowed("github-lookups");
  const servedReads = useRef(0);
  const [polls, setPolls] = useState(0);
  const locked = stale || !confirmed;
  const sending = useRef(false);
  // The newer of the lookup and the checks read (Mac 4.10, 16 Oct).
  const state = ref
    ? prBarState({ number: ref.number, lookupState: pr.state, lookupAt: checkedAt, read })
    : pr.state.toLowerCase();
  const reported = ref ? checksStateFor(ref.number, read) : null;
  const open = state === "open";
  const merge = autoMergeView(checks);
  const autoMergeOn = merge.kind === "on";
  const reloadedFor = useRef<string | null>(null);

  // Checks: read once when the bar shows (or when you ask, with lookups off),
  // and again on each poll tick. Turning auto-merge on does not read twice.
  // With lookups off a new PR address, or the bar opening again, is not an
  // ask: only a new Check now or auto-merge change reads (K7).
  useEffect(() => {
    if (!ref || !open) return;
    if (!lookupsOn && reads === servedReads.current) return;
    servedReads.current = reads;
    let cancelled = false;
    const number = ref.number;
    setLoading(true);
    fetchGithubPrChecks(cwd, ref.repo, number)
      .then((next) => {
        if (cancelled) return;
        setChecks(next, number);
        setChecksError(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setChecksError(String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      // A read cut short is not read again with lookups off, so the
      // spinner must not stay.
      setLoading(false);
    };
    // `ref` is rebuilt each render from the URL; its key is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, pr.url, open, reads, lookupsOn, polls]);

  // Every minute while auto-fix or auto-merge is on, with lookups on.
  useEffect(() => {
    if (!ref || !open || !lookupsOn) return;
    if (!settings.autoFix && !autoMergeOn) return;
    const timer = setInterval(() => setPolls((value) => value + 1), CHECK_POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pr.url, open, lookupsOn, settings.autoFix, autoMergeOn]);

  // Auto-fix: send the repair prompt when checks fail, within the limits.
  useEffect(() => {
    if (!ref || sending.current) return;
    const decision = decideAutoFix({ settings, checks, hasChat: Boolean(sessionId) });
    if (!decision.send || !checks || !sessionId) return;
    const host = prBarHost();
    if (!host) return;
    sending.current = true;
    const request = buildCiRepairRequest({
      repo: ref.repo,
      number: ref.number,
      headOid: checks.headOid,
      evidence: decision.failed,
    });
    void host
      .submitRepair(sessionId, request)
      .then((sent) => {
        if (sent) {
          savePrBarSettings(ref, {
            fixAttempts: settings.fixAttempts + 1,
            lastFixedHead: checks.headOid,
          });
          setNote(`Sent a repair for ${decision.failed.length} failed check${decision.failed.length === 1 ? "" : "s"}.`);
        } else {
          setNote("The chat is busy; the repair waits for the next check.");
        }
      })
      .catch((error: unknown) => setNote(`Could not send the repair: ${String(error)}`))
      .finally(() => {
        sending.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checks, settings, sessionId, pr.url]);

  // GitHub reports the PR merged or closed and the lookup does not say so
  // yet: run the lookup again, so the rest of the panel catches up. Once for
  // each state a read reports, so two reads that disagree cannot loop.
  // With lookups off it does not run: nobody asked for it, and the bar
  // already shows the state from the read (K7).
  useEffect(() => {
    if (!lookupsOn) return;
    if (!reloadPr || !reported || reported === "open") return;
    if (pr.state.toLowerCase() === reported) return;
    if (reloadedFor.current === reported) return;
    reloadedFor.current = reported;
    reloadPr();
  }, [reported, pr.state, reloadPr, lookupsOn]);

  // Auto-archive: once the PR is merged or closed.
  useEffect(() => {
    if (!ref || !sessionId) return;
    if (!shouldAutoArchive({ settings, state, hasChat: true })) return;
    const host = prBarHost();
    if (!host) return;
    savePrBarSettings(ref, { archived: true });
    void host.archiveSession(sessionId).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, settings.autoArchive, sessionId, pr.url]);

  if (!ref) return null;

  const preferred: MergeMethod = settings.mergeMethod ?? "squash";

  // On: GitHub's enablePullRequestAutoMerge, for the head the bar showed.
  // Off: disablePullRequestAutoMerge, only while GitHub reports a request.
  // Either way the PR is read again and the switch shows what GitHub says;
  // a failed call is not taken as a result (Mac 4.10, retest 3).
  const setAutoMerge = async (on: boolean) => {
    if (!checks?.prId) return;
    if (on && merge.kind !== "available") return;
    if (!on && merge.kind !== "on") return;
    setBusy(true);
    setNote(undefined);
    try {
      const result = await setPrAutoMerge(
        cwd,
        ref.repo,
        ref.number,
        on
          ? {
              enable: true,
              prId: checks.prId,
              method: preferred,
              expectedHeadOid: checks.headOid,
            }
          : { enable: false, prId: checks.prId },
      );
      if (result.pr) setChecks(result.pr, ref.number);
      else setReads((value) => value + 1);
      const notes = [
        result.refusal ? autoMergeRefusalText(result.refusal) : undefined,
        result.readError
          ? `Could not read the PR again: ${result.readError}`
          : undefined,
      ].filter(Boolean);
      setNote(notes.length ? notes.join(" ") : undefined);
    } catch (error) {
      setNote(`Could not change auto-merge: ${String(error)}`);
      setReads((value) => value + 1);
    } finally {
      setBusy(false);
    }
  };

  const summary = summarizePrChecks({ loading: loading && !checks, error: checksError, checks: checks?.checks ?? null });
  const warning = settings.autoFix ? autoFixWarning(route?.modelId) : undefined;
  return (
    <section
      data-pr-bar
      aria-label={`Pull request #${ref.number}`}
      className="mt-1.5 rounded-md border border-content/10 bg-content/3 p-2 text-[12px]"
    >
      <div className="flex items-center gap-1.5 text-content/70">
        <GitPullRequest className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          #{ref.number} · {open ? summary.description : state}
          {stale ? (
            <span data-pr-lookup-stale className="text-amber-400">
              {" · "}
              {/* Off, nothing retries, so say it failed (K7). */}
              {lookupsOn ? lastCheckedText(checkedAt) : lookupFailedText(checkedAt)}
            </span>
          ) : null}
        </span>
        {loading ? <Loader className="size-3 animate-spin" /> : null}
        {!lookupsOn && open && !loading ? (
          <button
            type="button"
            onClick={() => {
              setReads((value) => value + 1);
              // J1: one PR lookup as well, which you asked for, so a cached PR
              // can be confirmed and the switches unlock. Nothing runs on its
              // own after it: no retry, no reload after the read (K7).
              reloadPr?.();
            }}
            className="shrink-0 rounded px-1 text-[11px] text-content/60 hover:bg-content/10"
          >
            Check now
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-1.5 flex flex-col gap-1">
          {merge.kind === "merge-now" || merge.kind === "draft" ? (
            <p data-auto-merge-note className="text-[11px] text-content/55">
              {merge.text}
            </p>
          ) : (
            <label className="flex items-center gap-2">
              <Switch
                label="Auto-merge"
                on={autoMergeOn}
                disabled={busy || locked || merge.kind === "unknown"}
                onChange={(on) => void setAutoMerge(on)}
              />
              <span className="flex-1">Auto-merge</span>
              <select
                aria-label="Merge method"
                value={merge.kind === "on" ? (merge.method ?? preferred) : preferred}
                // The method of a request GitHub holds is shown, not changed
                // here; off, then on, changes it.
                disabled={busy || locked || merge.kind !== "available"}
                onChange={(event) =>
                  savePrBarSettings(ref, { mergeMethod: event.target.value as MergeMethod })
                }
                className="h-5 rounded bg-content/10 px-1 text-[11px] text-content disabled:opacity-40"
              >
                <option value="squash">Squash</option>
                <option value="merge">Merge</option>
                <option value="rebase">Rebase</option>
              </select>
            </label>
          )}
          {merge.kind === "on" ? (
            <p data-auto-merge-note className="text-[11px] text-content/55">
              {merge.text}
            </p>
          ) : null}
          <label className="flex items-center gap-2">
            <Switch
              label="Auto-fix failed checks"
              on={settings.autoFix}
              disabled={!sessionId || locked}
              onChange={(on) => savePrBarSettings(ref, on ? { autoFix: true, fixAttempts: 0 } : { autoFix: false })}
            />
            <span className="flex-1">
              Auto-fix failed checks
              {settings.autoFix ? (
                <span className="text-content/45"> · {settings.fixAttempts} of {MAX_FIX_ATTEMPTS} tries</span>
              ) : null}
            </span>
          </label>
          <label className="flex items-center gap-2">
            <Switch
              label="Archive the chat when merged or closed"
              on={settings.autoArchive}
              disabled={!sessionId || locked}
              onChange={(on) => savePrBarSettings(ref, { autoArchive: on, archived: false })}
            />
            <span className="flex-1">Archive the chat when merged or closed</span>
          </label>
          {!sessionId ? (
            <p className="text-[11px] text-content/45">No open chat works in this checkout, so auto-fix and archive are off.</p>
          ) : null}
          {warning ? <p className="text-[11px] text-amber-400">{warning}</p> : null}
        </div>
      ) : null}
      {note ? <p className="mt-1 text-[11px] text-content/55">{note}</p> : null}
    </section>
  );
}
