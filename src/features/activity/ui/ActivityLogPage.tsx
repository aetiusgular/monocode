import { useCallback, useEffect, useState } from "react";
import {
  applyFloor,
  collectorInstallPlan,
  collectorStatus,
  loadFloorGb,
  NO_STATUS,
  registerCollector,
  removeCollector,
  saveFloorGb,
  statusLine,
  type CollectorStatus,
  type InstallPlan,
} from "../model/collectorSettings";

const NOTE = "text-[11px] leading-4 text-content/45";
const BUTTON =
  "h-7 rounded-md bg-content/8 px-2.5 text-[12px] text-content hover:bg-content/14 disabled:opacity-40";
const CODE =
  "max-h-56 overflow-auto whitespace-pre rounded-md border border-content/10 bg-content/4 p-2 font-mono text-[11px] leading-4 text-content/85";

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Something went wrong.";
}

function copy(text: string) {
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    // Select and copy by hand.
  }
}

export function InstallPlanView({
  plan,
  busy,
  onRegister,
}: {
  plan: InstallPlan;
  busy: boolean;
  onRegister: () => void;
}) {
  return (
    <div data-activity-plan={plan.route} className="flex flex-col gap-2">
      <ul className="flex list-disc flex-col gap-1 pl-4 text-[12px] leading-4.5 text-content/80">
        {plan.explanation.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {plan.route === "smAppService" ? (
        <>
          <p className={NOTE}>
            MonoCode registers the collector with macOS. macOS then asks you to
            allow it in System Settings, General, Login Items. Grant it Full
            Disk Access in Privacy &amp; Security.
          </p>
          <button
            type="button"
            data-activity-register
            className={BUTTON}
            disabled={busy}
            onClick={onRegister}
          >
            Install the collector
          </button>
        </>
      ) : (
        <>
          <p className={NOTE}>
            This is a development build, so MonoCode does not install anything
            itself. Run these in Terminal. The second checks the copied
            binary&apos;s SHA-256 before the last one starts it.
          </p>
          <pre data-activity-commands className={CODE}>
            {plan.commands.join("\n")}
          </pre>
          <div className="flex gap-2">
            <button
              type="button"
              className={BUTTON}
              onClick={() => copy(plan.commands.join("\n"))}
            >
              Copy commands
            </button>
          </div>
          <details>
            <summary className="cursor-pointer text-[12px] text-content/70">
              The launchd file
              {plan.stagedPlist ? `, at ${plan.stagedPlist}` : ""}
            </summary>
            <pre className={CODE}>{plan.plist}</pre>
          </details>
          <p className={NOTE}>
            Then grant Full Disk Access to
            /Library/PrivilegedHelperTools/com.monocode.desktop.activity-collector
            in System Settings, Privacy &amp; Security.
          </p>
        </>
      )}
    </div>
  );
}

/** Settings, Activity log: the collector and how long the log is kept. */
export function ActivityLogPage() {
  const [status, setStatus] = useState<CollectorStatus>(NO_STATUS);
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [removal, setRemoval] = useState<string[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [floor, setFloor] = useState(loadFloorGb);

  const refresh = useCallback(async () => {
    setStatus(await collectorStatus());
  }, []);

  useEffect(() => {
    void refresh();
    void applyFloor();
  }, [refresh]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  return (
    <div data-activity-log-page className="flex flex-col gap-5">
      <p className={NOTE}>
        The activity log records what agents did, so you can see later what
        happened while you were away. It blocks nothing. Approvals, telemetry
        and computer-use records are kept by the app. Process and file events
        need the collector, a separate program that runs as root.
      </p>
      <section
        data-setting-id="activity-collector"
        id="setting-activity-collector"
        className="flex flex-col gap-2"
      >
        <h3 className="text-[13px] font-medium text-content">Collector</h3>
        <p data-activity-status className="text-[12px] text-content/80">
          {statusLine(status)}
        </p>
        {status.supported ? (
          <div className="flex flex-wrap gap-2">
            {!status.installed ? (
              <button
                type="button"
                data-activity-show-plan
                className={BUTTON}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setRemoval(null);
                    setPlan(await collectorInstallPlan());
                  })
                }
              >
                Show what the install does
              </button>
            ) : (
              <button
                type="button"
                data-activity-remove
                className={BUTTON}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setPlan(null);
                    const commands = await removeCollector();
                    setRemoval(commands);
                    if (!commands.length) setMessage("Removed.");
                  })
                }
              >
                Remove the collector
              </button>
            )}
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={() => void refresh()}
            >
              Check again
            </button>
          </div>
        ) : null}
        {plan ? (
          <InstallPlanView
            plan={plan}
            busy={busy}
            onRegister={() =>
              void run(async () => {
                const result = await registerCollector();
                setMessage(
                  result === "enabled"
                    ? "Installed."
                    : "Registered. Allow it in System Settings, General, Login Items.",
                );
              })
            }
          />
        ) : null}
        {removal?.length ? (
          <>
            <p className={NOTE}>Run these in Terminal to remove it.</p>
            <pre className={CODE}>{removal.join("\n")}</pre>
          </>
        ) : null}
        {message ? (
          <p data-activity-message className="text-[12px] text-content/80">
            {message}
          </p>
        ) : null}
      </section>
      <section
        data-setting-id="activity-retention"
        id="setting-activity-retention"
        className="flex flex-col gap-2"
      >
        <h3 className="text-[13px] font-medium text-content">Kept</h3>
        <p className={NOTE}>
          7 days of records and 3 days of screenshots, at most 1 GB, the oldest
          day deleted first. Everything stays on this Mac.
        </p>
        <label className="flex items-center gap-2 text-[12px] text-content/80">
          Stop screenshots when free disk falls under
          <input
            type="number"
            min={0.25}
            step={0.25}
            value={floor}
            data-activity-floor
            className="h-7 w-20 rounded-md border border-content/10 bg-transparent px-2 font-mono text-[12px] text-content"
            onChange={(event) => setFloor(Number(event.target.value))}
            onBlur={() => void saveFloorGb(floor).then(setFloor)}
          />
          GB
        </label>
      </section>
    </div>
  );
}
