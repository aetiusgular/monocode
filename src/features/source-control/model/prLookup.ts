import type { GitPr } from "../../../platform/tauri/fs";
import { prRefFromUrl } from "../../pr-bar/model/prBar";

/**
 * The pull request lookup behind the Changes panel's PR bar and Create PR
 * (Mac test 4.10, retest 3). A failed `gh` lookup used to read as "no PR",
 * so after a DNS failure Create PR showed for 1 to 3 minutes on a branch with
 * an open PR. Now:
 *
 * - `git_pr_status` errors when `gh` fails, and answers `null` only when `gh`
 *   answered and found none (or cannot be asked: not installed, signed out).
 * - The last known PR for a folder and branch is kept on an error, and across
 *   a reload, with the time it was last checked. While a lookup has failed
 *   the state is stale, and the bar's switches are off.
 * - A failure retries after 5 s, 15 s and 45 s, then waits for the normal
 *   triggers (opening the panel, window focus, the user's own git actions).
 *   Retries are calls nobody asked for, so they run only with "GitHub
 *   lookups" on. Off, a lookup you ask for runs once (K7).
 *
 * VS Code's GitHub extension, GitHub Desktop and lazygit keep the last good
 * value the same way; Superset's error-to-null is what this avoids.
 */
export type PrLookupState = {
  pr: GitPr | null;
  /** The latest lookup in this app run answered (with a PR or with none). */
  answered: boolean;
  /** The latest lookup failed; `pr` is the last known value. */
  stale: boolean;
  /** When a lookup last answered for this folder and branch, if ever. */
  checkedAt: number | null;
  /**
   * Shown from the cache with "GitHub lookups" off: no lookup in this run
   * confirmed it, so the PR bar keeps its switches off (review H1).
   */
  cachedOnly?: boolean;
};

export const PR_RETRY_DELAYS_MS = [5_000, 15_000, 45_000] as const;
export const PR_STATUS_KEY = "monocode.prStatus";
const MAX_CACHED = 50;

type Cached = { pr: GitPr | null; checkedAt: number };

let memory: Map<string, Cached> | null = null;

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function prLookupKey(cwd: string, branch: string): string {
  return `${cwd}\n${branch}`;
}

function sanitizePr(value: unknown): GitPr | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const number = Number(record.number);
  if (
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    typeof record.url !== "string" ||
    // Only a github.com pull request address is kept: View PR opens it
    // (review of the 15 Oct pass, G3).
    !prRefFromUrl(record.url) ||
    typeof record.state !== "string" ||
    typeof record.title !== "string"
  ) {
    return undefined;
  }
  return {
    number,
    title: record.title.slice(0, 500),
    url: record.url.slice(0, 500),
    state: record.state.slice(0, 20),
  };
}

function load(): Map<string, Cached> {
  if (memory) return memory;
  memory = new Map();
  let parsed: unknown;
  try {
    const raw = storage()?.getItem(PR_STATUS_KEY);
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }
  if (Array.isArray(parsed)) {
    for (const entry of parsed.slice(0, MAX_CACHED)) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
      const value = entry[1] as Record<string, unknown> | undefined;
      const pr = sanitizePr(value?.pr);
      const checkedAt = Number(value?.checkedAt);
      if (pr === undefined || !Number.isFinite(checkedAt)) continue;
      memory.set(entry[0], { pr, checkedAt });
    }
  }
  return memory;
}

function save(key: string, cached: Cached): void {
  const map = load();
  map.delete(key);
  // Newest first, so the oldest folders fall off past the cap.
  const entries: [string, Cached][] = [[key, cached], ...map];
  memory = new Map(entries.slice(0, MAX_CACHED));
  try {
    storage()?.setItem(PR_STATUS_KEY, JSON.stringify([...memory]));
  } catch {
    // Storage blocked: the last answer lasts for this app run only.
  }
}

/** The state to show before any lookup in this run has answered. */
export function cachedPrLookupState(cwd: string, branch: string): PrLookupState {
  const cached = load().get(prLookupKey(cwd, branch));
  return {
    pr: cached?.pr ?? null,
    answered: false,
    stale: false,
    checkedAt: cached?.checkedAt ?? null,
  };
}

/** "last checked 10:42", for a stale lookup. */
export function lastCheckedText(checkedAt: number | null): string {
  if (checkedAt == null) return "not checked yet";
  return `last checked ${new Date(checkedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

/**
 * "lookup failed, last checked 10:42": a lookup you asked for with "GitHub
 * lookups" off failed, and nothing retries it (K7).
 */
export function lookupFailedText(checkedAt: number | null): string {
  return `lookup failed, ${lastCheckedText(checkedAt)}`;
}

/** Test seam: forget what this app run holds, as a reload does. */
export function resetPrLookupMemory(): void {
  memory = null;
}

export type PrLookup = {
  state(): PrLookupState;
  /**
   * Look the PR up now, if `allowed` says so. A pending retry is replaced.
   * Focus and the normal triggers call this.
   */
  run(): void;
  /**
   * Look the PR up now because the user asked (a commit, a push, a new PR,
   * Check now). Runs with "GitHub lookups" off, once (J1). A failure then
   * retries only with lookups on: off, nothing runs until you ask again (K7).
   */
  ask(): void;
  dispose(): void;
};

export function createPrLookup(input: {
  cwd: string;
  branch: string;
  fetch: (cwd: string) => Promise<GitPr | null>;
  onChange: (state: PrLookupState) => void;
  /** Whether a lookup may run at all (the "GitHub lookups" switch, 5.9). */
  allowed?: () => boolean;
  now?: () => number;
}): PrLookup {
  const key = prLookupKey(input.cwd, input.branch);
  const now = input.now ?? Date.now;
  let state = cachedPrLookupState(input.cwd, input.branch);
  let generation = 0;
  let retries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const set = (next: PrLookupState) => {
    state = next;
    if (!disposed) input.onChange(next);
  };
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const attempt = (asked: boolean) => {
    if (disposed) return;
    if (!asked && input.allowed && !input.allowed()) return;
    clearTimer();
    const mine = ++generation;
    input
      .fetch(input.cwd)
      .then((pr) => {
        if (disposed || mine !== generation) return;
        const checkedAt = now();
        save(key, { pr, checkedAt });
        retries = 0;
        set({ pr, answered: true, stale: false, checkedAt });
      })
      .catch(() => {
        if (disposed || mine !== generation) return;
        set({ ...state, answered: false, stale: true });
        // A retry is a call nobody asked for: only with lookups on (K7).
        if (input.allowed && !input.allowed()) return;
        if (retries < PR_RETRY_DELAYS_MS.length) {
          const delay = PR_RETRY_DELAYS_MS[retries];
          retries += 1;
          // Checked again when it fires, in case lookups went off meanwhile.
          timer = setTimeout(() => attempt(false), delay);
        }
      });
  };

  return {
    state: () => state,
    run: () => attempt(false),
    ask: () => attempt(true),
    dispose: () => {
      disposed = true;
      clearTimer();
    },
  };
}
