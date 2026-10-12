import {
  killPty,
  spawnPty,
  subscribePty,
  type PtyCommand,
} from "../../../platform/tauri/pty";
import type {
  BackgroundItem,
  BackgroundItemKind,
} from "../../../integrations/harness/core/background";

/**
 * Processes MonoCode starts itself for a session, such as a preview server.
 * They run on the PTY backend, outside any harness sandbox, with the user's
 * full rights. So the caller must have shown the exact command and had the
 * user confirm it before calling `startOwnedProcess`.
 */
export type OwnedProcessKind = Extract<BackgroundItemKind, "server" | "shell">;

export type OwnedProcessStatus = "starting" | "running" | "exited" | "failed";

export type OwnedProcess = {
  id: string;
  sessionId: string;
  cwd: string;
  kind: OwnedProcessKind;
  title: string;
  command: PtyCommand;
  status: OwnedProcessStatus;
  startedAt: number;
  exitCode?: number | null;
  error?: string;
  /** Text output, newest last, bounded to `MAX_OUTPUT_CHARS`. */
  output: string;
};

export type StartOwnedProcessInput = {
  sessionId: string;
  cwd: string;
  title: string;
  kind?: OwnedProcessKind;
  command: PtyCommand;
  /**
   * The user saw this command and said yes. There is no default: a caller
   * that cannot say so cannot start a process.
   */
  confirmedByUser: true;
};

/** The PTY calls, replaceable in tests. */
export type OwnedProcessPty = {
  spawn: typeof spawnPty;
  kill: typeof killPty;
  subscribe: typeof subscribePty;
};

export const MAX_OUTPUT_CHARS = 200_000;
export const MAX_PROCESSES_PER_SESSION = 8;
const PTY_COLS = 120;
const PTY_ROWS = 32;

let pty: OwnedProcessPty = {
  spawn: spawnPty,
  kill: killPty,
  subscribe: subscribePty,
};

const processes = new Map<string, OwnedProcess>();
const unsubscribers = new Map<string, () => void>();
const decoders = new Map<string, TextDecoder>();
const listeners = new Set<() => void>();
let version = 0;

/** Test seam. */
export function setOwnedProcessPtyForTest(next: OwnedProcessPty | null): void {
  pty = next ?? { spawn: spawnPty, kill: killPty, subscribe: subscribePty };
}

/** Test seam: forget every process without killing anything. */
export function resetOwnedProcessesForTest(): void {
  for (const unsubscribe of unsubscribers.values()) unsubscribe();
  processes.clear();
  unsubscribers.clear();
  decoders.clear();
  listeners.clear();
  version = 0;
}

function changed(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

/** For `useSyncExternalStore`. */
export function subscribeOwnedProcesses(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes whenever any process changes, for `useSyncExternalStore`. */
export function ownedProcessesVersion(): number {
  return version;
}

export function ownedProcessesForSession(sessionId: string): OwnedProcess[] {
  return [...processes.values()]
    .filter((process) => process.sessionId === sessionId)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function getOwnedProcess(id: string): OwnedProcess | undefined {
  return processes.get(id);
}

function update(id: string, patch: Partial<OwnedProcess>): void {
  const current = processes.get(id);
  if (!current) return;
  processes.set(id, { ...current, ...patch });
  changed();
}

/** Keeps the newest output, cut at a line start where one is near. */
export function appendBoundedOutput(
  current: string,
  chunk: string,
  max = MAX_OUTPUT_CHARS,
): string {
  const next = current + chunk;
  if (next.length <= max) return next;
  const cut = next.length - max;
  const newline = next.indexOf("\n", cut);
  return newline >= 0 && newline - cut < 2_000
    ? next.slice(newline + 1)
    : next.slice(cut);
}

function validCommand(command: PtyCommand): boolean {
  return (
    typeof command.program === "string" &&
    command.program.trim().length > 0 &&
    !command.program.includes("\0") &&
    (command.args ?? []).every(
      (arg) => typeof arg === "string" && !arg.includes("\0"),
    )
  );
}

export async function startOwnedProcess(
  input: StartOwnedProcessInput,
): Promise<OwnedProcess> {
  if (input.confirmedByUser !== true) {
    throw new Error("A process MonoCode starts needs your confirmation first");
  }
  if (!input.cwd || input.cwd === "~") {
    throw new Error("A process needs a project folder to run in");
  }
  if (!validCommand(input.command)) {
    throw new Error("This command cannot be started");
  }
  const running = ownedProcessesForSession(input.sessionId).filter(
    (process) => process.status === "starting" || process.status === "running",
  );
  if (running.length >= MAX_PROCESSES_PER_SESSION) {
    throw new Error(
      `At most ${MAX_PROCESSES_PER_SESSION} processes can run for one chat`,
    );
  }
  const id = `owned-${crypto.randomUUID()}`;
  const process: OwnedProcess = {
    id,
    sessionId: input.sessionId,
    cwd: input.cwd,
    kind: input.kind ?? "shell",
    title: input.title.trim().slice(0, 200) || input.command.program,
    command: {
      program: input.command.program,
      args: [...(input.command.args ?? [])],
      ...(input.command.env ? { env: { ...input.command.env } } : {}),
    },
    status: "starting",
    startedAt: Date.now(),
    output: "",
  };
  processes.set(id, process);
  const decoder = new TextDecoder();
  decoders.set(id, decoder);
  // Listen before the spawn, so the first output is not lost.
  unsubscribers.set(
    id,
    pty.subscribe(
      id,
      (bytes) => {
        const current = processes.get(id);
        if (!current) return;
        const text = decoder.decode(bytes, { stream: true });
        if (!text) return;
        update(id, { output: appendBoundedOutput(current.output, text) });
      },
      (code) => {
        if (!processes.has(id)) return;
        const tail = decoder.decode();
        const current = processes.get(id);
        update(id, {
          status: "exited",
          exitCode: code,
          ...(tail && current
            ? { output: appendBoundedOutput(current.output, tail) }
            : {}),
        });
        unsubscribers.get(id)?.();
        unsubscribers.delete(id);
        decoders.delete(id);
      },
    ),
  );
  changed();
  try {
    await pty.spawn(id, input.cwd, PTY_COLS, PTY_ROWS, process.command);
    // The exit can arrive before the spawn call returns for a quick command.
    if (processes.get(id)?.status === "starting") update(id, { status: "running" });
  } catch (error) {
    unsubscribers.get(id)?.();
    unsubscribers.delete(id);
    decoders.delete(id);
    update(id, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return processes.get(id) ?? process;
}

/** Stops one process. Its output stays until it is cleared. */
export async function stopOwnedProcess(id: string): Promise<boolean> {
  const process = processes.get(id);
  if (!process) return false;
  if (process.status !== "starting" && process.status !== "running") {
    return false;
  }
  // killPty drops the PTY's handlers, so no exit event follows: mark it here.
  unsubscribers.get(id)?.();
  unsubscribers.delete(id);
  decoders.delete(id);
  await pty.kill(id);
  update(id, { status: "exited", exitCode: null });
  return true;
}

/** Stops every process of a session, for when it closes or is deleted. */
export async function stopOwnedProcessesForSession(
  sessionId: string,
): Promise<void> {
  await Promise.all(
    ownedProcessesForSession(sessionId).map((process) =>
      stopOwnedProcess(process.id),
    ),
  );
}

/** Removes a finished process and its output from the list. */
export function clearOwnedProcess(id: string): boolean {
  const process = processes.get(id);
  if (!process || process.status === "starting" || process.status === "running")
    return false;
  processes.delete(id);
  changed();
  return true;
}

/** An owned process as a Running row. */
export function ownedProcessItem(process: OwnedProcess): BackgroundItem {
  return {
    id: process.id,
    kind: process.kind,
    title: process.title,
    status:
      process.status === "starting" || process.status === "running"
        ? "running"
        : process.status === "failed" ||
            (process.exitCode != null && process.exitCode !== 0)
          ? "failed"
          : "done",
    startedAt: process.startedAt,
    stoppable:
      process.status === "starting" || process.status === "running",
    source: "monocode",
  };
}

/** The command as it would be typed, for showing before a start. */
export function describeCommand(command: PtyCommand): string {
  const quote = (part: string) =>
    /^[A-Za-z0-9_./:=@%+-]+$/.test(part)
      ? part
      : `'${part.replace(/'/g, `'\\''`)}'`;
  return [command.program, ...(command.args ?? [])].map(quote).join(" ");
}
