import { invoke } from "@tauri-apps/api/core";
import {
  describeCommand,
  getOwnedProcess,
  startOwnedProcess,
  stopOwnedProcess,
  subscribeOwnedProcesses,
  type OwnedProcess,
  type StartOwnedProcessInput,
} from "../../owned-processes/model/ownedProcesses";
import {
  isPreviewConfirmed,
  recordPreviewConfirmed,
} from "./confirmations";
import {
  previewCandidates,
  previewFingerprint,
  type PreviewCandidate,
  type PreviewCandidates,
  type PreviewConfigFiles,
} from "./launchConfig";
import {
  normalizePreviewUrl,
  previewUrlForPort,
  previewUrlFromOutput,
} from "./previewUrl";

/**
 * #37: one preview server per chat, started by MonoCode on F3's process
 * registry in the chat's working copy. The registry already holds the output
 * and the stop; this store adds the address, the probe, and what the pane and
 * the agent are told.
 *
 * A preview server runs the project's code with the user's full rights,
 * outside any harness sandbox, and reloads files as the agent edits them. It
 * starts only from a user's confirmation of the exact command; an agent may
 * restart one the user confirmed, and nothing more.
 */

export type PreviewStatus =
  /** The process is starting and no address is known yet. */
  | "starting"
  /** The address is known; the server has not answered yet. */
  | "waiting"
  /** The server answered. */
  | "ready"
  /** The process stopped, by the user, an agent, or itself. */
  | "stopped"
  /** The process could not start, or exited with an error. */
  | "failed";

export type PreviewFrame = {
  blocked: boolean;
  /** The header that refuses framing, for the banner. */
  reason?: string;
};

export type AppPreview = {
  sessionId: string;
  /** Where confirmations are kept: the chat's project. */
  project: string;
  /** The chat's working copy, where the configuration was read. */
  workCwd: string;
  /** The folder the process runs in. */
  runCwd: string;
  processId: string;
  candidate: PreviewCandidate;
  fingerprint: string;
  /** The command as it would be typed. */
  command: string;
  port?: number;
  url?: string;
  status: PreviewStatus;
  /** The last HTTP status the probe saw. */
  httpStatus?: number;
  frame?: PreviewFrame;
  error?: string;
  startedAt: number;
};

export type PreviewProbeResult = {
  status?: number | null;
  frameBlocked?: boolean;
  frameReason?: string | null;
  error?: string | null;
};

/** The calls this store makes, replaceable in tests. */
export type PreviewDeps = {
  readConfig(root: string): Promise<PreviewConfigFiles>;
  resolveCwd(root: string, relative: string): Promise<string>;
  freePort(): Promise<number>;
  probe(url: string): Promise<PreviewProbeResult>;
  start(input: StartOwnedProcessInput): Promise<OwnedProcess>;
  stop(id: string): Promise<boolean>;
  process(id: string): OwnedProcess | undefined;
  subscribe(listener: () => void): () => void;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
};

const DEFAULT_DEPS: PreviewDeps = {
  readConfig: (root) => invoke<PreviewConfigFiles>("preview_read_config", { root }),
  resolveCwd: (root, relative) =>
    invoke<string>("preview_resolve_cwd", { root, relative }),
  freePort: () => invoke<number>("preview_free_port"),
  probe: (url) => invoke<PreviewProbeResult>("preview_probe", { url }),
  start: startOwnedProcess,
  stop: stopOwnedProcess,
  process: getOwnedProcess,
  subscribe: subscribeOwnedProcesses,
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/** Probe every second while the server comes up, then every 3 seconds. */
export const PROBE_FAST_MS = 1_000;
export const PROBE_SLOW_MS = 3_000;
const FAST_WINDOW_MS = 30_000;
/** A server that has not answered in two minutes is left alone until asked. */
export const PROBE_GIVE_UP_MS = 120_000;

let deps: PreviewDeps = DEFAULT_DEPS;
const previews = new Map<string, AppPreview>();
const timers = new Map<string, unknown>();
const listeners = new Set<() => void>();
let version = 0;
let unsubscribeProcesses: (() => void) | undefined;

/** Test seam. */
export function setPreviewDepsForTest(next: Partial<PreviewDeps> | null): void {
  resetPreviewsForTest();
  deps = next ? { ...DEFAULT_DEPS, ...next } : DEFAULT_DEPS;
}

/** Test seam: forget every preview without stopping anything. */
export function resetPreviewsForTest(): void {
  for (const handle of timers.values()) deps.clearTimeout(handle);
  timers.clear();
  previews.clear();
  listeners.clear();
  unsubscribeProcesses?.();
  unsubscribeProcesses = undefined;
  version = 0;
}

function changed(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function subscribePreviews(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function previewsVersion(): number {
  return version;
}

export function previewForSession(sessionId: string): AppPreview | undefined {
  return previews.get(sessionId);
}

export function runningPreviews(): AppPreview[] {
  return [...previews.values()].filter(isPreviewLive);
}

export function isPreviewLive(preview: AppPreview | undefined): boolean {
  return (
    !!preview &&
    (preview.status === "starting" ||
      preview.status === "waiting" ||
      preview.status === "ready")
  );
}

function set(sessionId: string, patch: Partial<AppPreview>): AppPreview | undefined {
  const current = previews.get(sessionId);
  if (!current) return undefined;
  const next = { ...current, ...patch };
  previews.set(sessionId, next);
  changed();
  return next;
}

/** The configurations a chat's working copy offers. Starts nothing. */
export async function loadPreviewCandidates(workCwd: string): Promise<PreviewCandidates> {
  const files = await deps.readConfig(workCwd);
  return previewCandidates(files);
}

/** Whether this exact command was confirmed in this project before. */
export function previewNeedsConfirmation(
  project: string,
  candidate: PreviewCandidate,
): boolean {
  return !isPreviewConfirmed(project, previewFingerprint(candidate));
}

export type StartPreviewInput = {
  sessionId: string;
  project: string;
  workCwd: string;
  candidate: PreviewCandidate;
  /**
   * The user saw this command and said yes, now. There is no default, as for
   * F3's processes.
   */
  confirmedByUser: true;
};

function watchProcesses(): void {
  if (unsubscribeProcesses) return;
  unsubscribeProcesses = deps.subscribe(() => {
    for (const preview of [...previews.values()]) syncFromProcess(preview);
  });
}

/** Follow the process: its exit, and the address it prints. */
function syncFromProcess(preview: AppPreview): void {
  if (!isPreviewLive(preview)) return;
  const process = deps.process(preview.processId);
  if (!process) {
    set(preview.sessionId, { status: "stopped" });
    cancelProbe(preview.sessionId);
    return;
  }
  if (process.status === "failed") {
    set(preview.sessionId, {
      status: "failed",
      error: process.error ?? "The server could not start",
    });
    cancelProbe(preview.sessionId);
    return;
  }
  if (process.status === "exited") {
    const failed = process.exitCode != null && process.exitCode !== 0;
    set(preview.sessionId, {
      status: failed ? "failed" : "stopped",
      ...(failed ? { error: `The server exited with code ${process.exitCode}` } : {}),
    });
    cancelProbe(preview.sessionId);
    return;
  }
  if (!preview.url) {
    const url = previewUrlFromOutput(process.output);
    if (url) {
      set(preview.sessionId, { url, status: "waiting" });
      scheduleProbe(preview.sessionId, 0);
    }
  }
}

function cancelProbe(sessionId: string): void {
  const handle = timers.get(sessionId);
  if (handle !== undefined) deps.clearTimeout(handle);
  timers.delete(sessionId);
}

function scheduleProbe(sessionId: string, ms: number): void {
  cancelProbe(sessionId);
  timers.set(
    sessionId,
    deps.setTimeout(() => {
      timers.delete(sessionId);
      void checkPreview(sessionId);
    }, ms),
  );
}

/**
 * One probe of the preview's address. While the server has not answered, it
 * schedules the next one, faster at first.
 */
export async function checkPreview(sessionId: string): Promise<AppPreview | undefined> {
  const before = previews.get(sessionId);
  if (!before?.url || !isPreviewLive(before)) return before;
  const result = await deps.probe(before.url).catch(
    (error: unknown): PreviewProbeResult => ({
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  const current = previews.get(sessionId);
  // Stopped or restarted while the probe ran: this answer is stale.
  if (!current || current.processId !== before.processId || !isPreviewLive(current))
    return current;
  if (typeof result.status === "number") {
    return set(sessionId, {
      status: "ready",
      httpStatus: result.status,
      frame: {
        blocked: result.frameBlocked === true,
        ...(result.frameReason ? { reason: result.frameReason } : {}),
      },
      error: undefined,
    });
  }
  const age = deps.now() - current.startedAt;
  const next = set(sessionId, {
    ...(current.status === "ready" ? { status: "waiting" as const } : {}),
    ...(result.error ? { error: result.error } : {}),
  });
  if (age < PROBE_GIVE_UP_MS)
    scheduleProbe(sessionId, age < FAST_WINDOW_MS ? PROBE_FAST_MS : PROBE_SLOW_MS);
  return next;
}

/**
 * Start a chat's preview from a candidate the user just confirmed. Stops the
 * chat's earlier preview first.
 */
export async function startPreview(input: StartPreviewInput): Promise<AppPreview> {
  if (input.confirmedByUser !== true)
    throw new Error("A preview starts only after you confirm its command");
  return launch(input, true);
}

async function launch(
  input: Omit<StartPreviewInput, "confirmedByUser">,
  fromUser: boolean,
): Promise<AppPreview> {
  const { sessionId, project, workCwd, candidate } = input;
  if (!project || !workCwd || workCwd === "~")
    throw new Error("A preview needs a project folder");
  const fingerprint = previewFingerprint(candidate);
  if (!fromUser && !isPreviewConfirmed(project, fingerprint))
    throw new Error(
      "This command changed since you confirmed it. Start the preview from the session panel.",
    );
  await stopPreview(sessionId);
  const runCwd = await deps.resolveCwd(workCwd, candidate.cwd);
  const port = candidate.autoPort ? await deps.freePort() : candidate.port;
  const env = {
    ...candidate.env,
    ...(candidate.autoPort && port ? { PORT: String(port) } : {}),
  };
  const command = {
    program: candidate.program,
    args: [...candidate.args],
    ...(Object.keys(env).length ? { env } : {}),
  };
  // Read the files once more, right before the spawn. An agent can rewrite
  // the launch file or the script while the confirm box is open, or between
  // the restart check and here, and npm reads package.json again when it
  // runs. A command that is no longer the one confirmed does not start.
  const latest = await loadPreviewCandidates(workCwd);
  const now = latest.candidates.find((entry) => entry.key === candidate.key);
  if (!now || previewFingerprint(now) !== fingerprint)
    throw new Error(
      fromUser
        ? "The command changed while you were confirming it. Look at it again before you start it."
        : "The preview's command changed since it was confirmed. Start it again from the session panel, where the new command is shown.",
    );
  if (fromUser) recordPreviewConfirmed(project, fingerprint);
  const known =
    (candidate.url ? normalizePreviewUrl(candidate.url) : undefined) ??
    (port ? previewUrlForPort(port) : undefined);
  watchProcesses();
  const process = await deps.start({
    sessionId,
    cwd: runCwd,
    title: `Preview: ${candidate.label}`,
    kind: "server",
    command,
    confirmedByUser: true,
  });
  const preview: AppPreview = {
    sessionId,
    project,
    workCwd,
    runCwd,
    processId: process.id,
    candidate,
    fingerprint,
    command: describeCommand(command),
    ...(port ? { port } : {}),
    ...(known ? { url: known } : {}),
    status: known ? "waiting" : "starting",
    startedAt: deps.now(),
  };
  previews.set(sessionId, preview);
  changed();
  syncFromProcess(preview);
  const synced = previews.get(sessionId) ?? preview;
  if (synced.url && isPreviewLive(synced)) scheduleProbe(sessionId, PROBE_FAST_MS);
  return previews.get(sessionId) ?? preview;
}

/** Stop a chat's preview. Its output stays in the Running section. */
export async function stopPreview(sessionId: string): Promise<boolean> {
  const preview = previews.get(sessionId);
  if (!preview) return false;
  cancelProbe(sessionId);
  const live = isPreviewLive(preview);
  set(sessionId, { status: "stopped" });
  return live ? deps.stop(preview.processId).catch(() => false) : false;
}

export type RestartPreviewOptions = {
  /**
   * The restart comes from an agent (the `preview.restart` app action), not
   * from the user's click. An agent may restart only a server that is
   * running now: one the user stopped, or one that failed, stays down until
   * the user starts it.
   */
  byAgent?: boolean;
};

/**
 * Stop and start the same command. Allowed only while that exact command is
 * still the confirmed one, so an agent can restart a server and never start
 * a different one.
 */
export async function restartPreview(
  sessionId: string,
  options: RestartPreviewOptions = {},
): Promise<AppPreview> {
  const preview = previews.get(sessionId);
  if (!preview)
    throw new Error("No preview has been started in this chat. Start one from the session panel.");
  if (options.byAgent && !isPreviewLive(preview))
    throw new Error(
      "The preview is not running. Only the user can start it again, from the session panel.",
    );
  // The files are read again: an agent may have changed the launch file or
  // the dev script since the user confirmed it, and a package manager runs the
  // script as it is now. A changed command waits for the user.
  const { candidates } = await loadPreviewCandidates(preview.workCwd);
  const current = candidates.find((entry) => entry.key === preview.candidate.key);
  if (!current || previewFingerprint(current) !== preview.fingerprint)
    throw new Error(
      "The preview's command changed since it was confirmed. Start it again from the session panel, where the new command is shown.",
    );
  return launch(
    {
      sessionId,
      project: preview.project,
      workCwd: preview.workCwd,
      candidate: current,
    },
    false,
  );
}

/** Forget a chat's preview, stopping it: the chat was deleted. */
export async function forgetPreview(sessionId: string): Promise<void> {
  await stopPreview(sessionId);
  previews.delete(sessionId);
  changed();
}

/** The preview's process in F3's registry. */
export function previewProcess(sessionId: string): OwnedProcess | undefined {
  const preview = previews.get(sessionId);
  return preview ? deps.process(preview.processId) : undefined;
}

/** The server's output since it started, newest last, from F3's registry. */
export function previewOutput(sessionId: string): string {
  const preview = previews.get(sessionId);
  if (!preview) return "";
  return deps.process(preview.processId)?.output ?? "";
}

/** For the preamble, the privacy view and the app actions. */
export function previewSummary(preview: AppPreview): {
  status: PreviewStatus;
  url?: string;
  command: string;
  httpStatus?: number;
  frameBlocked?: boolean;
  error?: string;
} {
  return {
    status: preview.status,
    ...(preview.url ? { url: preview.url } : {}),
    command: preview.command,
    ...(preview.httpStatus !== undefined ? { httpStatus: preview.httpStatus } : {}),
    ...(preview.frame?.blocked ? { frameBlocked: true } : {}),
    ...(preview.error ? { error: preview.error } : {}),
  };
}
