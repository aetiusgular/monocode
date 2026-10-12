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
import { setPrAutoMerge, type PrAutoAction } from "../data/prAuto";
import {
  autoFixWarning,
  decideAutoFix,
  MAX_FIX_ATTEMPTS,
  prBarHost,
  prRefFromUrl,
  savePrBarSettings,
  shouldAutoArchive,
  usePrBarSettings,
  type MergeMethod,
  type PrRef,
} from "../model/prBar";

/** How often the bar re-reads the checks while auto-fix is on. */
export const CHECK_POLL_MS = 60_000;

const AUTO_ACTION: Record<MergeMethod, PrAutoAction> = {
  merge: "auto-merge",
  squash: "auto-squash",
  rebase: "auto-rebase",
};

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
}: {
  cwd: string;
  pr: Pr;
  owner?: HelperTarget;
}) {
  const ref: PrRef | null = prRefFromUrl(pr.url);
  const settings = usePrBarSettings(ref);
  const route = isHelperRoute(owner) ? owner : undefined;
  const sessionId = route?.sessionId;
  const [checks, setChecks] = useState<GithubPrChecks | null>(null);
  const [checksError, setChecksError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const sending = useRef(false);
  const open = pr.state.toLowerCase() === "open";

  // Checks: read once, then every minute while auto-fix is on.
  useEffect(() => {
    if (!ref || !open) return;
    let cancelled = false;
    const load = () => {
      setLoading(true);
      fetchGithubPrChecks(cwd, ref.repo, ref.number)
        .then((next) => {
          if (cancelled) return;
          setChecks(next);
          setChecksError(null);
        })
        .catch((error: unknown) => {
          if (!cancelled) setChecksError(String(error));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    const timer = settings.autoFix ? setInterval(load, CHECK_POLL_MS) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // `ref` is rebuilt each render from the URL; its key is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, pr.url, open, settings.autoFix]);

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

  // Auto-archive: once the PR is merged or closed.
  useEffect(() => {
    if (!ref || !sessionId) return;
    if (!shouldAutoArchive({ settings, state: pr.state, hasChat: true })) return;
    const host = prBarHost();
    if (!host) return;
    savePrBarSettings(ref, { archived: true });
    void host.archiveSession(sessionId).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pr.state, settings.autoArchive, sessionId, pr.url]);

  if (!ref) return null;

  const setAutoMerge = async (method: MergeMethod | undefined) => {
    setBusy(true);
    setNote(undefined);
    try {
      await setPrAutoMerge(
        cwd,
        ref.repo,
        ref.number,
        method ? AUTO_ACTION[method] : "disable-auto",
      );
      savePrBarSettings(ref, { autoMerge: method });
      setNote(method ? "GitHub will merge once the required checks pass." : "Auto-merge is off.");
    } catch (error) {
      setNote(`GitHub refused: ${String(error)}`);
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
          #{ref.number} · {open ? summary.description : pr.state.toLowerCase()}
        </span>
        {loading ? <Loader className="size-3 animate-spin" /> : null}
      </div>
      {open ? (
        <div className="mt-1.5 flex flex-col gap-1">
          <label className="flex items-center gap-2">
            <Switch
              label="Auto-merge"
              on={Boolean(settings.autoMerge)}
              disabled={busy}
              onChange={(on) => void setAutoMerge(on ? (settings.autoMerge ?? "squash") : undefined)}
            />
            <span className="flex-1">Auto-merge</span>
            <select
              aria-label="Merge method"
              value={settings.autoMerge ?? "squash"}
              disabled={busy || !settings.autoMerge}
              onChange={(event) => void setAutoMerge(event.target.value as MergeMethod)}
              className="h-5 rounded bg-content/10 px-1 text-[11px] text-content disabled:opacity-40"
            >
              <option value="squash">Squash</option>
              <option value="merge">Merge</option>
              <option value="rebase">Rebase</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <Switch
              label="Auto-fix failed checks"
              on={settings.autoFix}
              disabled={!sessionId}
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
              disabled={!sessionId}
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
