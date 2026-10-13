import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  Bot,
  ChevronRight,
  CornerDownRight,
  Eye,
  Globe,
  Square,
  Terminal,
  X,
} from "../../../shared/ui/icons";
import type { BackgroundItem } from "../../../integrations/harness/core/background";
import {
  listHarnessBackgroundTasks_l1,
  stopHarnessBackgroundTask_l1,
} from "../../../integrations/harness/core/registry";
import {
  clearOwnedProcess,
  getOwnedProcess,
  ownedProcessesForSession,
  ownedProcessesVersion,
  ownedProcessItem,
  stopOwnedProcess,
  subscribeOwnedProcesses,
} from "../../owned-processes/model/ownedProcesses";
import type { Block, HarnessId } from "../../sessions/model/session";
import {
  harnessListsBackground,
  outputTail,
  plainTerminalText,
  runningElapsed,
  runningRowKey,
  sessionRunningRows,
  type RunningRow,
} from "../model/sessionRunning";
import { PanelSection } from "./PanelSection";

/** How often an open section asks a polled harness for its list, in ms. */
export const RUNNING_POLL_MS = 5_000;
/**
 * While a turn runs the section asks more often, so a command the turn
 * starts is listed within a few seconds (Mac test 1.8).
 */
export const RUNNING_BUSY_POLL_MS = 2_000;
/** How long a stop waits for the row to go before it reads as running again. */
const STOPPING_HOLD_MS = 15_000;

const ICON = {
  className: "size-3.5 shrink-0 text-content/50",
  strokeWidth: 1.75,
} as const;

const KIND_ICON: Record<BackgroundItem["kind"], ReactNode> = {
  shell: <Terminal {...ICON} />,
  subagent: <Bot {...ICON} />,
  monitor: <Eye {...ICON} />,
  server: <Globe {...ICON} />,
};

/**
 * Polls the harness's own list while the section is shown. Null means no
 * list right now: the harness lacks the method, its process is between
 * threads, or the call failed. While a turn runs that can change at any
 * moment (a Codex app-server is restarted when a chat's connectors change),
 * so the poll keeps asking. While idle it stops after a null and starts
 * again with the next turn. A Codex without the methods is remembered by
 * its adapter and costs no request.
 */
function usePolledBackground(
  harness: HarnessId,
  sessionId: string,
  active: boolean,
  busy: boolean,
): readonly BackgroundItem[] | null {
  const [items, setItems] = useState<readonly BackgroundItem[] | null>(null);
  const listed = harnessListsBackground(harness);
  useEffect(() => {
    setItems(null);
    if (!listed || !active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const next = await listHarnessBackgroundTasks_l1(harness, sessionId);
      if (stopped) return;
      setItems(next);
      if (next === null && !busy) return;
      timer = setTimeout(
        () => void tick(),
        busy ? RUNNING_BUSY_POLL_MS : RUNNING_POLL_MS,
      );
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    // A new turn can bring the list back, so `busy` restarts the poll.
  }, [harness, sessionId, active, listed, busy]);
  return items;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * What the session runs beside the turn: shells and monitors the agent left
 * going, subagents, and processes MonoCode started itself. Each row that can
 * be stopped on its own has a stop button. A MonoCode process keeps its
 * output, which opens under its row.
 */
export function RunningSection({
  sessionId,
  harness,
  blocks,
  pushed,
  busy,
  active = true,
  onShowInChat,
}: {
  sessionId: string;
  harness: HarnessId;
  blocks: readonly Block[];
  pushed?: readonly BackgroundItem[];
  busy?: boolean;
  /** False while the panel is behind another tab: no polling then. */
  active?: boolean;
  onShowInChat?: (blockId: string) => void;
}) {
  const version = useSyncExternalStore(
    subscribeOwnedProcesses,
    ownedProcessesVersion,
    ownedProcessesVersion,
  );
  const owned = useMemo(
    () => ownedProcessesForSession(sessionId).map(ownedProcessItem),
    // `version` changes whenever a process does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, version],
  );
  const polled = usePolledBackground(harness, sessionId, active, busy === true);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [open, setOpen] = useState<string | null>(null);
  const rows = useMemo(
    () =>
      sessionRunningRows({
        harness,
        pushed,
        polled,
        owned,
        blocks,
        stopping,
        busy: busy === true,
      }),
    [harness, pushed, polled, owned, blocks, stopping, busy],
  );
  const now = useNow(active && rows.some((row) => row.status === "running"));

  const stop = useCallback(
    async (row: RunningRow) => {
      const key = runningRowKey(row);
      setStopping((prev) => new Set(prev).add(key));
      setErrors((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
      const release = () =>
        setStopping((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      try {
        const ok =
          row.stop === "monocode"
            ? await stopOwnedProcess(row.id)
            : await stopHarnessBackgroundTask_l1(harness, sessionId, row.id);
        if (!ok) {
          release();
          setErrors((prev) =>
            new Map(prev).set(key, "It had already stopped, or cannot be stopped from here."),
          );
          return;
        }
        // The harness confirms by dropping the row; if it never does, stop
        // claiming it is stopping.
        setTimeout(release, STOPPING_HOLD_MS);
      } catch (error) {
        release();
        setErrors((prev) =>
          new Map(prev).set(
            key,
            error instanceof Error ? error.message : "Could not stop it.",
          ),
        );
      }
    },
    [harness, sessionId],
  );

  // Nothing to list and nothing MonoCode ran: the section stays out of the way.
  if (rows.length === 0) return null;
  const running = rows.filter((row) => row.status === "running").length;

  return (
    <PanelSection
      title="Running"
      fold="running"
      action={
        <span
          data-running-count
          className="shrink-0 rounded-full bg-content/7 px-2 py-0.5 font-mono text-[10px] text-content/50"
        >
          {running}
        </span>
      }
    >
      <ul className="flex flex-col gap-0.5" data-running-list>
        {rows.map((row) => {
          const key = runningRowKey(row);
          const process =
            row.source === "monocode" ? getOwnedProcess(row.id) : undefined;
          const expanded = open === key && !!process;
          const elapsed = runningElapsed(row.startedAt, now);
          const error = errors.get(key);
          return (
            <li key={key} data-running-row={row.kind} data-running-status={row.status}>
              <div className="group flex min-h-7 items-center gap-2 rounded-md px-2 text-[12px] hover:bg-content/5">
                {process ? (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={expanded ? "Hide output" : "Show output"}
                    title={expanded ? "Hide output" : "Show output"}
                    className="grid size-5 shrink-0 place-items-center rounded text-content/40 hover:text-content focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    onClick={() => setOpen(expanded ? null : key)}
                  >
                    <ChevronRight
                      className={`size-3 transition-transform ${expanded ? "rotate-90" : ""}`}
                      strokeWidth={1.75}
                    />
                  </button>
                ) : null}
                {KIND_ICON[row.kind]}
                <span
                  className={`min-w-0 flex-1 truncate ${
                    row.status === "running" ? "text-content/85" : "text-content/45"
                  }`}
                  title={row.title}
                >
                  {row.title}
                </span>
                <span className="shrink-0 font-mono text-[10.5px] text-content/40">
                  {row.status === "stopping"
                    ? "stopping"
                    : row.status === "running"
                      ? elapsed
                      : row.status === "failed"
                        ? "failed"
                        : "ended"}
                </span>
                {row.blockId && onShowInChat ? (
                  <button
                    type="button"
                    title="Show in chat"
                    aria-label={`Show ${row.title} in chat`}
                    className="grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    onClick={() => onShowInChat(row.blockId!)}
                  >
                    <CornerDownRight className="size-3.5" strokeWidth={1.75} />
                  </button>
                ) : null}
                {row.status === "running" && row.stop !== "turn" ? (
                  <button
                    type="button"
                    data-running-stop
                    title="Stop"
                    aria-label={`Stop ${row.title}`}
                    className="grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    onClick={() => void stop(row)}
                  >
                    <Square className="size-3" strokeWidth={2} />
                  </button>
                ) : null}
                {row.source === "monocode" &&
                row.status !== "running" &&
                row.status !== "stopping" ? (
                  <button
                    type="button"
                    title="Remove from the list"
                    aria-label={`Remove ${row.title} from the list`}
                    className="grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    onClick={() => clearOwnedProcess(row.id)}
                  >
                    <X className="size-3" strokeWidth={2} />
                  </button>
                ) : null}
              </div>
              {row.stop === "turn" && row.status === "running" ? (
                <p className="px-2 pl-7 text-[11px] leading-4 text-content/35">
                  Stops with the turn.
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="px-2 pl-7 text-[11px] leading-4 text-red-400">
                  {error}
                </p>
              ) : null}
              {expanded && process ? <ProcessOutput output={process.output} /> : null}
            </li>
          );
        })}
      </ul>
    </PanelSection>
  );
}

function ProcessOutput({ output }: { output: string }) {
  const { text, cut } = outputTail(plainTerminalText(output));
  return (
    <div className="mx-2 mb-1 mt-0.5 rounded-md bg-content/5">
      {cut ? (
        <p className="px-2 pt-1 text-[10.5px] text-content/40">
          Showing the last part of the output.
        </p>
      ) : null}
      <pre
        data-running-output
        className="max-h-60 overflow-auto whitespace-pre-wrap break-all px-2 py-1.5 font-mono text-[10.5px] leading-4 text-content/75"
      >
        {text || "No output yet."}
      </pre>
    </div>
  );
}
