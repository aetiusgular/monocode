import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  runtimeProviderBinaryPath,
  type ConfigurableBinaryProvider,
} from "../../../features/providers/model/providerBinaryPaths";

/** Process I/O is supplied by the desktop or a headless host. Provider
 * protocols never need to know which process owns their children. */
export interface ChildBackend {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<UnlistenFn>;
}

let backend: ChildBackend | undefined;

export function configureChildBackend(next: ChildBackend): void {
  if (bridge || users)
    throw new Error("Configure the child backend before starting the bridge");
  backend = next;
}

export function hasHeadlessChildBackend(): boolean {
  return backend !== undefined;
}

/** Provider-owned transcript files are read on the machine running the child. */
export function readHarnessTextFile(path: string): Promise<string> {
  return invoke<string>(backend ? "harness_read_text_file" : "read_text_file", {
    path,
  });
}

export function prepareMonoCodexStore(
  providerAccountId?: string,
  threadId?: string,
): Promise<{ home: string; hasThread: boolean }> {
  return invoke("codex_mono_store_prepare", { providerAccountId, threadId });
}

export function copyMonoCodexThreads(
  providerAccountId: string | undefined,
  threadId: string,
  paths: string[],
  sqliteHome?: string,
): Promise<void> {
  return invoke("codex_mono_store_copy", {
    providerAccountId,
    threadId,
    paths,
    sqliteHome,
  });
}

export function restoreMonoCodexAgentState(
  providerAccountId: string | undefined,
  threadId: string,
): Promise<void> {
  return invoke("codex_mono_store_restore_agent_state", {
    providerAccountId,
    threadId,
  });
}

function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return backend
    ? backend.invoke<T>(command, args)
    : tauriInvoke<T>(command, args);
}

function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
  return backend ? backend.listen(event, handler) : tauriListen(event, handler);
}

type LinePayload = { sessionId: string; line: string };
// The desktop batches a frame's stdout lines and SSE events into one event;
// the remote host still sends them one at a time. `seq` numbers the first
// line; the rest follow it one by one. The remote host sends none.
type LinesPayload =
  LinePayload | { sessionId: string; lines: string[]; seq?: number };
type ExitPayload = {
  sessionId: string;
  code: number | null;
  pid?: number;
  seq?: number;
};
type BufferedLine = { line: string; seq?: number };
type SsePayload =
  { sessionId: string; data: string } | { sessionId: string; events: string[] };
type SseEndPayload = { sessionId: string; error?: string | null };

type LineHandler = (line: string) => void;
type ExitHandler = (code: number | null) => void;
type SseHandler = (data: string) => void;
type SseEndHandler = (error?: string) => void;

const lineHandlers = new Map<string, LineHandler>();
const exitHandlers = new Map<string, ExitHandler>();
const lineBuffer = new Map<string, BufferedLine[]>();
const stderrHandlers = new Map<string, LineHandler>();
const sseHandlers = new Map<string, SseHandler>();
const sseEndHandlers = new Map<string, SseEndHandler>();
const sseBuffer = new Map<string, string[]>();
// Output is broadcast to every window. Only ids this window spawned or opened
// may buffer while unwatched; anything else would be held until the bridge
// is torn down, since nothing here ever watches or unwatches it.
const ownedChildren = new Set<string>();
const ownedSse = new Set<string>();
const livePid = new Map<string, number>();
const pendingExit = new Map<
  string,
  Array<{ code: number | null; pid: number }>
>();
/**
 * The newest sequence number this window handed on, or buffered, per session.
 * A replay after a reload and the live events overlap; anything at or below
 * it was seen already (Mac test 2.8).
 */
const seenSeq = new Map<string, number>();
/** A re-attached child's exit that came before anything watched it. */
const replayedExit = new Map<string, number | null>();
/** An exit that came while a reload's children were still being taken back. */
const unwatchedExit = new Map<string, { code: number | null; pid: number }>();

/** True when this exit belongs to the child we currently have spawned. */
export function isCurrentChildExit(
  expectedPid: number | undefined,
  exitedPid: number | undefined,
): boolean {
  if (expectedPid == null || expectedPid <= 0) return false;
  if (exitedPid == null || exitedPid <= 0) return false;
  return exitedPid === expectedPid;
}

const MAX_BUFFERED = 1000;
let bridge: Promise<UnlistenFn[]> | null = null;
let bridgeAttempt: symbol | null = null;
let users = 0;
let teardownTimer: ReturnType<typeof setTimeout> | undefined;

function pushBounded<T>(
  map: Map<string, T[]>,
  sessionId: string,
  item: T,
  max = MAX_BUFFERED,
) {
  const queued = map.get(sessionId) ?? [];
  queued.push(item);
  if (queued.length > max) {
    queued.splice(0, queued.length - max);
  }
  map.set(sessionId, queued);
}

function ensureBridge() {
  if (bridge) return;
  let failed = false;
  const installed: UnlistenFn[] = [];
  const register = (pending: Promise<UnlistenFn>) =>
    pending.then((unlisten) => {
      if (failed) {
        unlisten();
        return () => undefined;
      }
      installed.push(unlisten);
      return unlisten;
    });
  const attempt = Symbol("bridge-installation");
  bridgeAttempt = attempt;
  const installation = Promise.all([
    register(
      listen<LinesPayload>("harness-stdout", (event) => {
        const { payload } = event;
        const { sessionId } = payload;
        const lines = "lines" in payload ? payload.lines : [payload.line];
        const first = "seq" in payload ? payload.seq : undefined;
        lines.forEach((line, offset) =>
          deliverLine(
            sessionId,
            line,
            first == null ? undefined : first + offset,
          ),
        );
      }),
    ),
    register(
      listen<LinePayload>("harness-stderr", (event) => {
        const { sessionId, line } = event.payload;
        stderrHandlers.get(sessionId)?.(line);
      }),
    ),
    register(
      listen<ExitPayload>("harness-exit", (event) => {
        const { sessionId, code, pid, seq } = event.payload;
        if (!isNewSeq(sessionId, seq)) return;
        const handler = exitHandlers.get(sessionId);
        if (!handler && pid != null && ownedChildren.has(sessionId)) {
          // A child being taken back after a reload: nothing watches it yet.
          if (reattached.has(sessionId)) {
            if (pid === livePid.get(sessionId))
              replayedExit.set(sessionId, code);
          } else unwatchedExit.set(sessionId, { code, pid });
          return;
        }
        if (!handler || pid == null || pid <= 0) return;
        const currentPid = livePid.get(sessionId);
        if (isCurrentChildExit(currentPid, pid)) {
          livePid.delete(sessionId);
          handler(code);
          return;
        }
        if (currentPid != null) return;
        const exits = pendingExit.get(sessionId) ?? [];
        exits.push({ code, pid });
        if (exits.length > 8) exits.splice(0, exits.length - 8);
        pendingExit.set(sessionId, exits);
      }),
    ),
    register(
      listen<SsePayload>("harness-sse", (event) => {
        const { payload } = event;
        const { sessionId } = payload;
        const events = "events" in payload ? payload.events : [payload.data];
        for (const data of events) {
          const handler = sseHandlers.get(sessionId);
          if (handler) handler(data);
          else if (ownedSse.has(sessionId)) {
            pushBounded(sseBuffer, sessionId, data);
          }
        }
      }),
    ),
    register(
      listen<SseEndPayload>("harness-sse-end", (event) => {
        const { sessionId, error } = event.payload;
        sseEndHandlers.get(sessionId)?.(error ?? undefined);
      }),
    ),
  ]).catch((error: unknown) => {
    failed = true;
    installed.splice(0).forEach((unlisten) => unlisten());
    if (bridgeAttempt === attempt) {
      bridge = null;
      bridgeAttempt = null;
    }
    throw error;
  });
  void installation.catch(() => undefined);
  bridge = installation;
}

function teardownBridge() {
  const pending = bridge;
  bridge = null;
  bridgeAttempt = null;
  lineHandlers.clear();
  exitHandlers.clear();
  lineBuffer.clear();
  stderrHandlers.clear();
  sseHandlers.clear();
  sseEndHandlers.clear();
  sseBuffer.clear();
  ownedChildren.clear();
  ownedSse.clear();
  livePid.clear();
  pendingExit.clear();
  seenSeq.clear();
  replayedExit.clear();
  unwatchedExit.clear();
  reattached.clear();
  void pending?.then((fns) => fns.forEach((fn) => fn())).catch(() => undefined);
}

/** False for a numbered item this window already handed on. */
function isNewSeq(sessionId: string, seq: number | undefined): boolean {
  if (seq == null) return true;
  if (seq <= (seenSeq.get(sessionId) ?? 0)) return false;
  seenSeq.set(sessionId, seq);
  return true;
}

function deliverLine(sessionId: string, line: string, seq?: number) {
  if (!isNewSeq(sessionId, seq)) return;
  // A handler may detach mid-batch; later lines follow the old path.
  const handler = lineHandlers.get(sessionId);
  if (handler) handler(line);
  else if (ownedChildren.has(sessionId)) {
    // A replay holds up to Rust's bound (`REPLAY_MAX_LINES`); keep all of it.
    pushBounded(
      lineBuffer,
      sessionId,
      { line, seq },
      reattached.has(sessionId) ? REPLAY_MAX_LINES : MAX_BUFFERED,
    );
  }
}

/** Rust keeps this many lines per session for a replay. */
const REPLAY_MAX_LINES = 4000;

/**
 * Where a reload leaves this window's children: Rust keeps them running and
 * keeps their output (`harness_replay`); the page forgets them. Survives a
 * reload in the same webview, not a quit.
 */
const RELOAD_KEY = "monocode.harnessReloadChildren";

export type ReloadChild = { sessionId: string; pid: number; lastSeq: number };

/**
 * Before the page unloads: note these sessions' live children, so the page
 * that loads next can take them back. Synchronous, so it lands in time.
 */
export function saveChildrenForReload(sessionIds: Iterable<string>): void {
  const rows: ReloadChild[] = [];
  for (const sessionId of sessionIds) {
    const pid = livePid.get(sessionId);
    if (pid == null || pid <= 0) continue;
    // Lines still buffered never reached an adapter: replay them too.
    const buffered = lineBuffer.get(sessionId)?.find((entry) => entry.seq);
    const lastSeq = buffered?.seq
      ? buffered.seq - 1
      : (seenSeq.get(sessionId) ?? 0);
    rows.push({ sessionId, pid, lastSeq });
  }
  try {
    if (rows.length) sessionStorage.setItem(RELOAD_KEY, JSON.stringify(rows));
    else sessionStorage.removeItem(RELOAD_KEY);
  } catch {
    // No storage: the chats fall back to Continue.
  }
}

function takeSavedChildren(): ReloadChild[] {
  try {
    const raw = sessionStorage.getItem(RELOAD_KEY);
    sessionStorage.removeItem(RELOAD_KEY);
    const rows: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(rows)) return [];
    return rows.filter(
      (row): row is ReloadChild =>
        !!row &&
        typeof row.sessionId === "string" &&
        typeof row.pid === "number" &&
        row.pid > 0 &&
        typeof row.lastSeq === "number",
    );
  } catch {
    return [];
  }
}

/** Sessions whose child this page took back after a reload. */
const reattached = new Set<string>();
let reattaching: Promise<Set<string>> | null = null;

type LiveSessionRow = {
  sessionId: string;
  pid: number;
  lastSeq: number;
  exited: boolean;
};
type ReplayResult = {
  entries: { seq: number; line: string }[];
  exit?: { code: number | null; pid: number; seq: number } | null;
  firstSeq: number;
  lastSeq: number;
  truncated: boolean;
};

async function reattachSavedChildren(): Promise<Set<string>> {
  const saved = takeSavedChildren();
  const taken = new Set<string>();
  if (saved.length === 0 || backend) return taken;
  // Own them first: live lines that arrive before the replay are buffered.
  for (const row of saved) ownedChildren.add(row.sessionId);
  let release: (() => void) | undefined;
  try {
    // Listening before asking: a line printed after the replay was read
    // then arrives live instead of being lost.
    release = await acquireHarnessBridge();
    const live = await invoke<LiveSessionRow[]>("harness_live_sessions");
    for (const row of saved) {
      const now = live.find((entry) => entry.sessionId === row.sessionId);
      if (!now || now.pid !== row.pid) continue;
      const replay = await invoke<ReplayResult>("harness_replay", {
        sessionId: row.sessionId,
        afterSeq: row.lastSeq,
      });
      // Lines past the bound are gone: the turn cannot be rebuilt.
      if (replay.truncated) continue;
      livePid.set(row.sessionId, row.pid);
      reattached.add(row.sessionId);
      // Replayed lines go ahead of live ones buffered meanwhile; a live line
      // the replay also has is dropped by its number.
      const arrived = lineBuffer.get(row.sessionId) ?? [];
      lineBuffer.delete(row.sessionId);
      const merged = [
        ...replay.entries.map((entry) => ({
          line: entry.line,
          seq: entry.seq,
        })),
        ...arrived,
      ].sort((x, y) => (x.seq ?? Infinity) - (y.seq ?? Infinity));
      // Count from where the old page stopped; the live lines buffered
      // meanwhile moved the mark past the replay's.
      seenSeq.set(row.sessionId, row.lastSeq);
      for (const entry of merged)
        deliverLine(row.sessionId, entry.line, entry.seq);
      const early = unwatchedExit.get(row.sessionId);
      unwatchedExit.delete(row.sessionId);
      if (replay.exit?.pid === row.pid) {
        replayedExit.set(row.sessionId, replay.exit.code);
        seenSeq.set(
          row.sessionId,
          Math.max(seenSeq.get(row.sessionId) ?? 0, replay.exit.seq),
        );
      } else if (early?.pid === row.pid) {
        replayedExit.set(row.sessionId, early.code);
      }
      taken.add(row.sessionId);
    }
  } catch {
    // Anything missing: these chats fall back to Continue.
  } finally {
    // The caller holds its own lease (`startHarnessBridge`): dropping the
    // last one would clear what was just buffered.
    release?.();
  }
  for (const row of saved) {
    unwatchedExit.delete(row.sessionId);
    if (taken.has(row.sessionId)) continue;
    ownedChildren.delete(row.sessionId);
    lineBuffer.delete(row.sessionId);
  }
  return taken;
}

/**
 * True when this page took back the session's child after a reload: the
 * same pid still runs (or just exited) in Rust, and every line this window
 * missed is buffered for the next `watchChild`. Once per page load. Call it
 * with the bridge held (`startHarnessBridge`).
 */
export function reattachChild(sessionId: string): Promise<boolean> {
  reattaching ??= reattachSavedChildren();
  return reattaching.then((taken) => taken.has(sessionId));
}

export function startHarnessBridge(): () => void {
  users += 1;
  if (teardownTimer) {
    clearTimeout(teardownTimer);
    teardownTimer = undefined;
  }
  ensureBridge();
  return () => {
    users -= 1;
    if (users > 0) return;
    users = 0;
    teardownTimer = setTimeout(() => {
      teardownTimer = undefined;
      if (users === 0) teardownBridge();
    }, 0);
  };
}

export async function acquireHarnessBridge(): Promise<() => void> {
  const release = startHarnessBridge();
  const installation = bridge;
  try {
    await installation;
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    users = 0;
    if (teardownTimer) {
      clearTimeout(teardownTimer);
      teardownTimer = undefined;
    }
    teardownBridge();
  });
}

export function watchChild(
  sessionId: string,
  onLine: LineHandler,
  onExit: ExitHandler,
  onStderr?: LineHandler,
) {
  const queued = lineBuffer.get(sessionId);
  lineBuffer.delete(sessionId);
  lineHandlers.set(sessionId, onLine);
  exitHandlers.set(sessionId, onExit);
  if (onStderr) stderrHandlers.set(sessionId, onStderr);
  if (queued) queued.forEach((entry) => onLine(entry.line));
  if (replayedExit.has(sessionId) && exitHandlers.get(sessionId) === onExit) {
    const code = replayedExit.get(sessionId) ?? null;
    replayedExit.delete(sessionId);
    livePid.delete(sessionId);
    onExit(code);
  }
}

export function unwatchChild(sessionId: string) {
  lineHandlers.delete(sessionId);
  exitHandlers.delete(sessionId);
  lineBuffer.delete(sessionId);
  ownedChildren.delete(sessionId);
  stderrHandlers.delete(sessionId);
  pendingExit.delete(sessionId);
  replayedExit.delete(sessionId);
  unwatchedExit.delete(sessionId);
  reattached.delete(sessionId);
}

export function watchSse(
  sessionId: string,
  onData: SseHandler,
  onEnd?: SseEndHandler,
) {
  const queued = sseBuffer.get(sessionId);
  sseBuffer.delete(sessionId);
  sseHandlers.set(sessionId, onData);
  if (onEnd) sseEndHandlers.set(sessionId, onEnd);
  if (queued) queued.forEach(onData);
}

export function unwatchSse(sessionId: string) {
  sseHandlers.delete(sessionId);
  sseEndHandlers.delete(sessionId);
  sseBuffer.delete(sessionId);
  ownedSse.delete(sessionId);
}

export async function spawnChild(
  sessionId: string,
  command: string,
  args: string[],
  cwd: string,
  account?: { provider: "claude" | "codex"; id: string },
  binaryProvider?: ConfigurableBinaryProvider,
  codexStore?: "mono",
  /** `devin acp` only: start with an approval rule for every edit. */
  devinAskEdits?: boolean,
): Promise<void> {
  livePid.delete(sessionId);
  pendingExit.delete(sessionId);
  ownedChildren.add(sessionId);
  const binaryPath = binaryProvider
    ? runtimeProviderBinaryPath(binaryProvider)
    : undefined;
  const pid = await invoke<number>("harness_spawn", {
    sessionId,
    command,
    args,
    cwd,
    account,
    binaryProvider,
    binaryPath,
    ...(codexStore ? { codexStore } : {}),
    ...(devinAskEdits ? { devinAskEdits } : {}),
  });
  if (typeof pid !== "number" || pid <= 0) return;
  livePid.set(sessionId, pid);
  const exits = pendingExit.get(sessionId);
  pendingExit.delete(sessionId);
  const exited = exits?.find((event) => event.pid === pid);
  if (!exited) return;
  livePid.delete(sessionId);
  exitHandlers.get(sessionId)?.(exited.code);
}

export function writeChild(sessionId: string, line: string): Promise<void> {
  return invoke("harness_write", { sessionId, line });
}

export function killChild(sessionId: string): Promise<void> {
  livePid.delete(sessionId);
  pendingExit.delete(sessionId);
  unwatchChild(sessionId);
  return invoke("harness_kill", { sessionId });
}

/** `keep`: chats a reloading page hands to the next one; left running. */
export function killAllChildren(keep: string[] = []): Promise<void> {
  lineHandlers.clear();
  exitHandlers.clear();
  lineBuffer.clear();
  stderrHandlers.clear();
  sseHandlers.clear();
  sseEndHandlers.clear();
  sseBuffer.clear();
  ownedChildren.clear();
  ownedSse.clear();
  livePid.clear();
  pendingExit.clear();
  seenSeq.clear();
  replayedExit.clear();
  unwatchedExit.clear();
  reattached.clear();
  return invoke("harness_kill_all", keep.length ? { keep } : undefined);
}

type ResolvedHarnessBinary = { path: string; args?: string[] };

async function resolveHarnessBinary(
  provider: ConfigurableBinaryProvider,
  binaryPath?: string | null,
): Promise<ResolvedHarnessBinary> {
  const configuredPath =
    binaryPath === undefined
      ? runtimeProviderBinaryPath(provider)
      : binaryPath?.trim();
  if (configuredPath) {
    return invoke("harness_resolve_configured", {
      provider,
      binaryPath: configuredPath,
    });
  }
  const command: Record<ConfigurableBinaryProvider, string> = {
    claude: "harness_resolve_claude",
    codex: "harness_resolve_codex",
    cursor: "harness_resolve_cursor",
    grok: "harness_resolve_grok",
    opencode: "harness_resolve_opencode",
    pi: "harness_resolve_pi",
    omp: "harness_resolve_omp",
    fx: "harness_resolve_fx",
    hermes: "harness_resolve_hermes",
    antigravity: "harness_resolve_antigravity",
    devin: "harness_resolve_devin",
  };
  return invoke(command[provider]);
}

export function resolveCursorBinary(
  binaryPath?: string | null,
): Promise<{ path: string }> {
  return resolveHarnessBinary("cursor", binaryPath);
}

export function resolveCodexBinary(
  binaryPath?: string | null,
): Promise<{ path: string }> {
  return resolveHarnessBinary("codex", binaryPath);
}

export function resolveOpenCodeBinary(
  binaryPath?: string | null,
): Promise<{ path: string }> {
  return resolveHarnessBinary("opencode", binaryPath);
}

export function resolveClaudeBinary(
  binaryPath?: string | null,
): Promise<{ path: string }> {
  return resolveHarnessBinary("claude", binaryPath);
}

export function resolvePiBinary(
  binaryPath?: string | null,
): Promise<{ path: string }> {
  return resolveHarnessBinary("pi", binaryPath);
}

export function resolveOmpBinary(
  binaryPath?: string | null,
): Promise<{ path: string }> {
  return resolveHarnessBinary("omp", binaryPath);
}

export function resolveFxBinary(
  binaryPath?: string | null,
): Promise<{ path: string }> {
  return resolveHarnessBinary("fx", binaryPath);
}

export function resolveGrokBinary(
  binaryPath?: string | null,
): Promise<{ path: string }> {
  return resolveHarnessBinary("grok", binaryPath);
}

export function resolveHermesBinary(
  binaryPath?: string | null,
): Promise<{ path: string }> {
  return resolveHarnessBinary("hermes", binaryPath);
}

export function resolveDevinBinary(
  binaryPath?: string | null,
): Promise<{ path: string }> {
  return resolveHarnessBinary("devin", binaryPath);
}

export function resolveAntigravityBinary(
  binaryPath?: string | null,
): Promise<{ path: string; args: string[] }> {
  return resolveHarnessBinary("antigravity", binaryPath) as Promise<{
    path: string;
    args: string[];
  }>;
}

export function freeHarnessPort(): Promise<number> {
  return invoke("harness_free_port");
}

export function harnessHttp(input: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}): Promise<{ status: number; body: string }> {
  return invoke("harness_http", input);
}

export function openHarnessSse(
  sessionId: string,
  url: string,
  headers?: Record<string, string>,
): Promise<void> {
  ownedSse.add(sessionId);
  return invoke("harness_sse_open", { sessionId, url, headers });
}

export function closeHarnessSse(sessionId: string): Promise<void> {
  unwatchSse(sessionId);
  return invoke("harness_sse_close", { sessionId });
}

export type HarnessBinaryInspection = {
  path: string;
  version?: string;
  error?: string;
};

export function inspectHarnessBinary(
  provider: ConfigurableBinaryProvider,
  binaryPath?: string | null,
): Promise<HarnessBinaryInspection> {
  return resolveHarnessBinary(provider, binaryPath).then(async (resolved) => {
    if (provider === "antigravity") {
      return { path: resolved.path, version: "ACP server" };
    }
    try {
      const version = (
        await execChild(
          resolved.path,
          ["--version"],
          undefined,
          provider,
          binaryPath,
        )
      ).trim();
      return /\d+\.\d+\.\d+/.test(version)
        ? { path: resolved.path, version }
        : { path: resolved.path, error: "CLI returned no valid version." };
    } catch (error) {
      return {
        path: resolved.path,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

/** Runs the CLI's own self-update against the binary MonoCode uses. */
export async function updateHarnessCli(
  provider: ConfigurableBinaryProvider,
): Promise<void> {
  const resolved = await resolveHarnessBinary(provider);
  await invoke("harness_update", {
    command: resolved.path,
    binaryProvider: provider,
    binaryPath: runtimeProviderBinaryPath(provider),
  });
}

export function execChild(
  command: string,
  args: string[],
  cwd?: string,
  binaryProvider?: ConfigurableBinaryProvider,
  binaryPathOverride?: string | null,
): Promise<string> {
  const binaryPath =
    binaryPathOverride === undefined && binaryProvider
      ? runtimeProviderBinaryPath(binaryProvider)
      : binaryPathOverride;
  return invoke("harness_exec", {
    command,
    args,
    cwd,
    binaryProvider,
    binaryPath,
  });
}
