import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useState, useSyncExternalStore } from "react";
import { PanelSection, EmptyNote } from "../../session-panel/ui/PanelSection";
import { isRemoteProjectPath } from "../../projects/model/recents";
import {
  setVerifyAuto,
  subscribeVerify,
  verifyNow,
  verifyState,
  verifyVersion,
} from "../../verify/model/verifyStore";
import { MAX_AUTO_SENDS } from "../../verify/model/verify";
import { previewConfirmText } from "../model/confirmText";
import type { PreviewCandidate, PreviewCandidates } from "../model/launchConfig";
import {
  isPreviewLive,
  loadPreviewCandidates,
  previewNeedsConfirmation,
  restartPreview,
  startPreview,
  stopPreview,
  type AppPreview,
} from "../model/previewStore";
import { previewHost, subscribePreviewHost } from "../model/previewHost";
import { useAppPreview } from "./AppPreviewPane";

/**
 * #37 in the session panel: start the chat's preview from a confirmed
 * command, see its address and state, open it, restart or stop it, and set
 * whether verify failures go to the agent by themselves (#38a).
 */

const BUTTON =
  "h-6.5 rounded-md px-2 text-[11.5px] font-medium text-content/75 hover:bg-content/8 hover:text-content disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent";
const PRIMARY =
  "h-6.5 rounded-md bg-content px-2.5 text-[11.5px] font-medium text-background-base hover:bg-content/90 disabled:cursor-not-allowed disabled:opacity-40";

function statusLabel(preview: AppPreview): string {
  switch (preview.status) {
    case "starting":
      return "Starting";
    case "waiting":
      return "Waiting for an answer";
    case "ready":
      return preview.frame?.blocked ? "Running, refuses framing" : "Running";
    case "stopped":
      return "Stopped";
    case "failed":
      return "Failed";
  }
}

export function PreviewServerSection({
  sessionId,
  project,
  workCwd,
}: {
  sessionId: string;
  /** The chat's project: where confirmations are kept. */
  project: string;
  /** The chat's working copy: where the server runs. */
  workCwd: string;
}) {
  const preview = useAppPreview(sessionId);
  useSyncExternalStore(subscribeVerify, verifyVersion, verifyVersion);
  const host = useSyncExternalStore(subscribePreviewHost, previewHost, previewHost);
  const verify = verifyState(sessionId);
  const [choices, setChoices] = useState<PreviewCandidates | null>(null);
  const [picked, setPicked] = useState<PreviewCandidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }, []);

  const remote = isRemoteProjectPath(workCwd) || isRemoteProjectPath(project);
  const live = isPreviewLive(preview);

  // A chat with no project folder has nothing to run.
  if (!workCwd || workCwd === "~" || !project || project === "~") return null;

  if (remote)
    return (
      <PanelSection title="Dev server" fold="app-preview">
        <EmptyNote>Previews run on this Mac only. This chat works on a remote machine.</EmptyNote>
      </PanelSection>
    );

  const begin = () =>
    run(async () => {
      setPicked(null);
      const found = await loadPreviewCandidates(workCwd);
      setChoices(found);
      if (found.candidates.length === 1) setPicked(found.candidates[0]);
    });

  const confirm = (candidate: PreviewCandidate) =>
    run(async () => {
      await startPreview({
        sessionId,
        project,
        workCwd,
        candidate,
        confirmedByUser: true,
      });
      setChoices(null);
      setPicked(null);
    });

  return (
    <PanelSection title="Dev server" fold="app-preview">
      <div className="flex flex-col gap-2 px-2" data-preview-section>
        {preview && live ? (
          <div className="flex flex-col gap-1.5" data-preview-live>
            <div className="flex min-w-0 items-center gap-2 text-[12px]">
              <span
                aria-hidden
                className={`size-2 shrink-0 rounded-full ${
                  preview.status === "ready" ? "bg-emerald-500" : "bg-amber-400"
                }`}
              />
              <span className="min-w-0 truncate font-mono text-content/80" title={preview.url}>
                {preview.url ?? "No address yet"}
              </span>
            </div>
            <p className="text-[11.5px] text-content/50">
              {statusLabel(preview)} · <span className="font-mono">{preview.command}</span>
            </p>
            <div className="flex flex-wrap gap-1">
              {host ? (
                <button type="button" className={BUTTON} onClick={() => host.openPane(sessionId)}>
                  Open pane
                </button>
              ) : null}
              <button
                type="button"
                className={BUTTON}
                disabled={!preview.url}
                onClick={() => {
                  if (preview.url) void openUrl(preview.url).catch(() => undefined);
                }}
              >
                Open in browser
              </button>
              <button
                type="button"
                className={BUTTON}
                disabled={busy}
                onClick={() => run(() => restartPreview(sessionId))}
              >
                Restart
              </button>
              <button
                type="button"
                className={BUTTON}
                disabled={busy}
                data-preview-stop
                onClick={() => run(() => stopPreview(sessionId))}
              >
                Stop
              </button>
              <button
                type="button"
                className={BUTTON}
                disabled={busy || verify.checking}
                title="Check the server, its output and the page now"
                onClick={() => run(() => verifyNow(sessionId, `manual-${Date.now()}`))}
              >
                Check now
              </button>
            </div>
            <label className="flex items-start gap-2 pt-1 text-[11.5px] leading-4 text-content/65">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={verify.auto}
                data-verify-auto
                onChange={(event) => setVerifyAuto(sessionId, event.currentTarget.checked)}
              />
              <span>
                Send a failed check after edits to the agent by itself, at most{" "}
                {MAX_AUTO_SENDS} times in a row. Needs a model that can fix code.
              </span>
            </label>
          </div>
        ) : null}

        {!live ? (
          <>
            {preview && (preview.status === "stopped" || preview.status === "failed") ? (
              <p className="text-[11.5px] text-content/55" data-preview-ended>
                {preview.status === "failed"
                  ? `The server failed${preview.error ? `: ${preview.error}` : ""}.`
                  : "The server has stopped."}
              </p>
            ) : null}
            {!choices ? (
              <div>
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy}
                  data-preview-begin
                  onClick={() => void begin()}
                >
                  {preview ? "Start again…" : "Start a preview…"}
                </button>
              </div>
            ) : (
              <PreviewChoices
                project={project}
                choices={choices}
                picked={picked}
                busy={busy}
                onPick={setPicked}
                onConfirm={(candidate) => void confirm(candidate)}
                onCancel={() => {
                  setChoices(null);
                  setPicked(null);
                }}
              />
            )}
          </>
        ) : null}
        {error ? (
          <p role="alert" className="text-[11.5px] text-red-500">
            {error}
          </p>
        ) : null}
      </div>
    </PanelSection>
  );
}

export function PreviewChoices({
  project,
  choices,
  picked,
  busy,
  onPick,
  onConfirm,
  onCancel,
}: {
  project: string;
  choices: PreviewCandidates;
  picked: PreviewCandidate | null;
  busy: boolean;
  onPick: (candidate: PreviewCandidate) => void;
  onConfirm: (candidate: PreviewCandidate) => void;
  onCancel: () => void;
}) {
  const { candidates, problems } = choices;
  const text = picked ? previewConfirmText(picked) : null;
  const again = picked ? !previewNeedsConfirmation(project, picked) : false;
  return (
    <div className="flex flex-col gap-2" data-preview-choices>
      {candidates.length === 0 ? (
        <EmptyNote>
          No .claude/launch.json configuration and no dev, start, serve or preview script
          in package.json.
        </EmptyNote>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {candidates.map((candidate) => (
            <li key={candidate.key}>
              <label className="flex min-h-7 items-center gap-2 rounded-md px-1 text-[12px] hover:bg-content/5">
                <input
                  type="radio"
                  name="preview-candidate"
                  checked={picked?.key === candidate.key}
                  onChange={() => onPick(candidate)}
                />
                <span className="min-w-0 truncate">{candidate.label}</span>
                <span className="ml-auto shrink-0 text-[10.5px] text-content/40">
                  {candidate.source}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {problems.length ? (
        <ul className="flex flex-col gap-0.5 text-[11px] text-content/45" data-preview-problems>
          {problems.slice(0, 6).map((problem) => (
            <li key={problem}>Left out: {problem}</li>
          ))}
        </ul>
      ) : null}
      {picked && text ? (
        <div
          className="flex flex-col gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-[11.5px] leading-4"
          data-preview-confirm
        >
          <p className="text-content/75">MonoCode will run, in {text.folder}:</p>
          <code className="block break-all rounded bg-content/7 px-1.5 py-1 font-mono text-[11px] text-content">
            {text.command}
          </code>
          {text.script ? (
            <p className="text-content/65">
              The script it runs:{" "}
              <code className="break-all font-mono text-[11px] text-content/85">{text.script}</code>
            </p>
          ) : null}
          {text.env.length ? (
            <p className="text-content/65">
              With:{" "}
              <code className="break-all font-mono text-[11px] text-content/85">
                {text.env.join(" ")}
              </code>
            </p>
          ) : null}
          {text.port ? <p className="text-content/65">Port: {text.port}</p> : null}
          <p className="text-content/50">From {text.source}.</p>
          <p className="text-amber-700 dark:text-amber-300">{text.warning}</p>
          {again ? (
            <p className="text-content/50">You confirmed this exact command in this project before.</p>
          ) : null}
          <div className="flex gap-1.5 pt-0.5">
            <button
              type="button"
              className={PRIMARY}
              disabled={busy}
              data-preview-run
              onClick={() => onConfirm(picked)}
            >
              {again ? "Start" : "Run it"}
            </button>
            <button type="button" className={BUTTON} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : candidates.length ? (
        <div>
          <button type="button" className={BUTTON} onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <div>
          <button type="button" className={BUTTON} onClick={onCancel}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
