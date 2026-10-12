import { pathKey } from "../../../shared/lib/paths";

/**
 * #37: which preview commands the user has confirmed, per project. A preview
 * runs the project's code with the user's full rights, outside any sandbox,
 * so MonoCode shows the command and asks before the first start in a project,
 * and again whenever the command changes (rules, section 5, items 2 and 4).
 *
 * Only fingerprints are kept, never the command or its environment. A
 * project keeps its last few, so switching between two configurations does
 * not ask every time; anything else asks.
 */

/** v2: SHA-256 fingerprints. v1 held 53-bit ones, which are dropped, so
 * every command asks once more. */
const KEY = "monocode.preview.confirmed.v2";
const PER_PROJECT = 8;
const MAX_PROJECTS = 200;

type Store = Record<string, string[]>;

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Store = {};
    for (const [project, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const prints = list.filter(
        (entry): entry is string => typeof entry === "string" && /^[0-9a-f]{64}$/.test(entry),
      );
      if (prints.length) out[project] = prints.slice(0, PER_PROJECT);
    }
    return out;
  } catch {
    return {};
  }
}

function save(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Private mode or a full quota: the next start asks again, which is safe.
  }
}

export function isPreviewConfirmed(project: string, fingerprint: string): boolean {
  if (!project || !fingerprint) return false;
  return load()[pathKey(project)]?.includes(fingerprint) ?? false;
}

export function recordPreviewConfirmed(project: string, fingerprint: string): void {
  if (!project || !fingerprint) return;
  const store = load();
  const key = pathKey(project);
  const list = [fingerprint, ...(store[key] ?? []).filter((entry) => entry !== fingerprint)];
  delete store[key];
  // Newest project last, so the oldest is dropped first when there are many.
  store[key] = list.slice(0, PER_PROJECT);
  const keys = Object.keys(store);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_PROJECTS)))
    delete store[old];
  save(store);
}

/** Forget every confirmation for a project: the next start asks. */
export function forgetPreviewConfirmations(project: string): void {
  const store = load();
  delete store[pathKey(project)];
  save(store);
}
