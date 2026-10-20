import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { PanelSection } from "../../session-panel/ui/PanelSection";
import {
  loadSectionCollapsed,
  subscribeSectionCollapsed,
} from "../../session-panel/model/sessionPanelState";
import {
  EMPTY_REPORT,
  eventsAround,
  expectedNote,
  fetchFlags,
  fetchScreenshot,
  keepCollectorState,
  KEEP_MS,
  markVisited,
  REASON_LABEL,
  reportNotes,
  sinceFor,
  type ActivityFlag,
  type FlagsReport,
} from "../model/activityPanel";
import {
  harnessGeneration,
  onActivityChange,
  RefreshScheduler,
} from "../model/activityRefresh";
import type { ActivityEvent } from "../model/activityTypes";

const NOTE = "px-2 pb-1 text-[12px] leading-4.5 text-content/45";
const BUTTON =
  "h-6.5 rounded-md px-2 text-[11px] text-content/70 hover:bg-content/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent";

function time(at: number): string {
  try {
    return new Date(at).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return String(at);
  }
}

function EventRow({
  event,
  flagged,
}: {
  event: ActivityEvent;
  flagged: boolean;
}) {
  return (
    <li
      data-activity-event={event.id}
      className={`grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 text-[11px] leading-4 ${
        flagged ? "text-content" : "text-content/55"
      }`}
    >
      <span className="font-mono">{time(event.at).split(", ").pop()}</span>
      <span className="min-w-0 break-words">
        <span className="font-mono text-content/45">
          {event.source} {event.kind}
        </span>{" "}
        {event.summary}
      </span>
    </li>
  );
}

function Screenshot({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void fetchScreenshot(path).then((next) => {
      if (live) setUrl(next);
    });
    return () => {
      live = false;
    };
  }, [path]);
  if (!url) return null;
  return (
    <img
      data-activity-screenshot
      src={url}
      alt="Screen near this action"
      className="mt-1 max-h-48 w-full rounded-md border border-content/10 object-contain"
    />
  );
}

export function FlagRow({
  flag,
  events,
}: {
  flag: ActivityFlag;
  events: readonly ActivityEvent[];
}) {
  const [open, setOpen] = useState(false);
  const around = open ? eventsAround(flag, events) : [];
  return (
    <li data-activity-flag={flag.reason} className="flex flex-col gap-1 px-2">
      <button
        type="button"
        aria-expanded={open}
        className="flex flex-col items-start gap-0.5 rounded-md px-1 py-1 text-left hover:bg-content/6 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex w-full items-center gap-2 text-[11px]">
          <span className="rounded-full bg-content/8 px-1.5 py-0.5 text-content/75">
            {REASON_LABEL[flag.reason] ?? flag.reason}
          </span>
          <span className="font-mono text-content/40">{time(flag.at)}</span>
          {flag.count && flag.count > 1 ? (
            <span data-activity-repeat className="font-mono text-content/40">
              ×{flag.count}, last{" "}
              {time(flag.lastAt ?? flag.at)
                .split(", ")
                .pop()}
            </span>
          ) : null}
        </span>
        <span className="break-words text-[12px] leading-4.5 text-content/90">
          {flag.summary}
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-1 pb-1 pl-1">
          {flag.screenshot ? <Screenshot path={flag.screenshot} /> : null}
          {around.length ? (
            <ul className="flex flex-col gap-0.5">
              {around.map((event) => (
                <EventRow
                  key={event.id}
                  event={event}
                  flagged={event.id === flag.eventId}
                />
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-content/40">
              No other events nearby.
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}

export function ActivityFlagsView({
  report,
  sinceVisit,
  loading,
  onMarkSeen,
  onShowWeek,
  onRefresh,
}: {
  report: FlagsReport;
  sinceVisit: boolean;
  loading: boolean;
  onMarkSeen: () => void;
  onShowWeek: () => void;
  onRefresh: () => void;
}) {
  const notes = reportNotes(report);
  const hidden = expectedNote(report);
  const [showExpected, setShowExpected] = useState(false);
  return (
    <div data-activity-section className="flex flex-col gap-1.5">
      {notes.map((note) => (
        <p key={note} data-activity-note className={NOTE}>
          {note}
        </p>
      ))}
      {hidden ? (
        <div className="flex items-center gap-1 px-1">
          <span data-activity-hidden className={NOTE}>
            {hidden}
          </span>
          <button
            type="button"
            data-activity-show-expected
            aria-expanded={showExpected}
            className={BUTTON}
            onClick={() => setShowExpected((value) => !value)}
          >
            {showExpected ? "Hide" : "Show"}
          </button>
        </div>
      ) : null}
      {hidden && showExpected && report.expected.length ? (
        <ul data-activity-expected className="flex flex-col gap-1 opacity-70">
          {report.expected.map((flag) => (
            <FlagRow key={flag.id} flag={flag} events={report.events} />
          ))}
        </ul>
      ) : null}
      {report.flags.length ? (
        <ul className="flex flex-col gap-1">
          {report.flags.map((flag) => (
            <FlagRow key={flag.id} flag={flag} events={report.events} />
          ))}
        </ul>
      ) : (
        <p className={NOTE}>
          {loading
            ? "Checking…"
            : sinceVisit
              ? "Nothing flagged since your last visit."
              : "Nothing flagged in the last 7 days."}
        </p>
      )}
      <div className="flex items-center gap-1 px-1">
        {report.flags.length ? (
          <button
            type="button"
            data-activity-seen
            className={BUTTON}
            onClick={onMarkSeen}
          >
            Mark seen
          </button>
        ) : null}
        {sinceVisit ? (
          <button
            type="button"
            data-activity-week
            className={BUTTON}
            onClick={onShowWeek}
          >
            Last 7 days
          </button>
        ) : null}
        <button
          type="button"
          data-activity-refresh
          className={BUTTON}
          onClick={onRefresh}
        >
          Check again
        </button>
      </div>
    </div>
  );
}

/**
 * The session panel's Activity section: what this chat's agent did that no
 * approval covered, since your last visit. Detection only. While it is
 * open it reads again on each tool call's end, 11 s after the last one, and
 * every 15 s; a harness restart reloads it (Mac test 3.8, 3.12b).
 */
export function ActivitySection({ sessionId }: { sessionId: string }) {
  const [report, setReport] = useState<FlagsReport>(EMPTY_REPORT);
  const [loading, setLoading] = useState(true);
  const [sinceVisit, setSinceVisit] = useState(true);
  const sinceVisitRef = useRef(true);
  sinceVisitRef.current = sinceVisit;
  // Bumped when this chat's harness starts again (a mode switch restarts
  // it with a new pid), so the section reloads (Mac test 3.12b).
  const [restarts, setRestarts] = useState(0);
  const collapsed = useSyncExternalStore(
    subscribeSectionCollapsed,
    () => loadSectionCollapsed("activity"),
    () => false,
  );

  const load = useCallback(
    async (fromVisit: boolean) => {
      setLoading(true);
      const since = fromVisit ? sinceFor(sessionId) : Date.now() - KEEP_MS;
      const next = await fetchFlags(sessionId, since);
      setReport(next);
      setLoading(false);
    },
    [sessionId],
  );

  useEffect(() => {
    setSinceVisit(true);
    void load(true);
  }, [load, restarts]);

  useEffect(() => {
    if (collapsed) return undefined;
    const scheduler = new RefreshScheduler(() => load(sinceVisitRef.current));
    scheduler.start();
    const off = onActivityChange((chatId, what) => {
      if (chatId !== sessionId) return;
      if (what === "restart") setRestarts(harnessGeneration(sessionId));
      else scheduler.callEnded();
    });
    return () => {
      off();
      scheduler.stop();
    };
  }, [sessionId, collapsed, load]);

  return (
    <PanelSection
      title="Activity"
      fold="activity"
      action={
        report.flags.length ? (
          <span
            data-activity-count
            className="shrink-0 rounded-full bg-content/7 px-2 py-0.5 font-mono text-[10px] text-content/50"
          >
            {report.flags.length}
          </span>
        ) : null
      }
    >
      <ActivityFlagsView
        report={report}
        sinceVisit={sinceVisit}
        loading={loading}
        onMarkSeen={() => {
          markVisited(sessionId);
          setSinceVisit(true);
          setReport((last) => keepCollectorState(last));
          setLoading(false);
        }}
        onShowWeek={() => {
          setSinceVisit(false);
          void load(false);
        }}
        onRefresh={() => void load(sinceVisit)}
      />
    </PanelSection>
  );
}
