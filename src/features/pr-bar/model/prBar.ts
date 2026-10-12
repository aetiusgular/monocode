import { useSyncExternalStore } from "react";
import type { GithubPrCheck, GithubPrChecks } from "../../inbox/model/githubPrChecks";
import type { CiRepairRequest } from "../../inbox/model/ciRepair";
import { modelCallsToolsReliably } from "../../model-traits/model/modelTraits";

/**
 * #33: the PR bar's switches for one pull request. Auto-merge is GitHub's own
 * (`gh pr merge --auto`). Auto-archive archives the PR's chat once the PR is
 * merged or closed. Auto-fix sends the CI repair prompt to the PR's chat when
 * checks fail: off by default, at most 2 tries, never twice for one commit.
 */
export type MergeMethod = "merge" | "squash" | "rebase";

export type PrBarSettings = {
  autoMerge?: MergeMethod;
  autoArchive: boolean;
  autoFix: boolean;
  /** Repairs sent so far. */
  fixAttempts: number;
  /** The head commit the last repair was sent for. */
  lastFixedHead?: string;
  /** True once the chat was archived for this PR. */
  archived?: boolean;
};

export const MAX_FIX_ATTEMPTS = 2;
export const PR_BAR_KEY = "monocode.prBar";
const MAX_PRS = 100;

export const DEFAULT_PR_BAR: PrBarSettings = {
  autoArchive: false,
  autoFix: false,
  fixAttempts: 0,
};

export type PrRef = { repo: string; number: number };

/**
 * The repository and number of a github.com pull request URL. Any other host
 * is refused: the PR bar is GitHub only.
 */
export function prRefFromUrl(url: string | null | undefined): PrRef | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
    return null;
  }
  const match = parsed.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/);
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { repo: `${match[1]}/${match[2]}`, number };
}

export function prKey(ref: PrRef): string {
  return `${ref.repo.toLowerCase()}#${ref.number}`;
}

function sanitizeSettings(value: unknown): PrBarSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_PR_BAR };
  }
  const record = value as Record<string, unknown>;
  const method = record.autoMerge;
  const attempts = Number(record.fixAttempts);
  return {
    ...(method === "merge" || method === "squash" || method === "rebase"
      ? { autoMerge: method }
      : {}),
    autoArchive: record.autoArchive === true,
    autoFix: record.autoFix === true,
    fixAttempts:
      Number.isInteger(attempts) && attempts >= 0
        ? Math.min(attempts, MAX_FIX_ATTEMPTS)
        : 0,
    ...(typeof record.lastFixedHead === "string" && /^[0-9a-f]{7,64}$/i.test(record.lastFixedHead)
      ? { lastFixedHead: record.lastFixedHead }
      : {}),
    ...(record.archived === true ? { archived: true } : {}),
  };
}

export function sanitizePrBarStore(value: unknown): Record<string, PrBarSettings> {
  const out: Record<string, PrBarSettings> = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  let count = 0;
  for (const [key, settings] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_PRS) break;
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+#\d+$/.test(key)) continue;
    out[key] = sanitizeSettings(settings);
    count += 1;
  }
  return out;
}

let cache: Record<string, PrBarSettings> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function loadStore(): Record<string, PrBarSettings> {
  if (cache) return cache;
  let parsed: unknown;
  try {
    const raw = storage()?.getItem(PR_BAR_KEY);
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }
  cache = sanitizePrBarStore(parsed);
  return cache;
}

export function prBarSettings(ref: PrRef): PrBarSettings {
  return loadStore()[prKey(ref)] ?? { ...DEFAULT_PR_BAR };
}

export function savePrBarSettings(ref: PrRef, patch: Partial<PrBarSettings>): PrBarSettings {
  const store = { ...loadStore() };
  const key = prKey(ref);
  const next = sanitizeSettings({ ...(store[key] ?? DEFAULT_PR_BAR), ...patch });
  delete store[key];
  // Newest first, so the oldest pull requests fall off past the cap.
  cache = sanitizePrBarStore({ [key]: next, ...store });
  try {
    storage()?.setItem(PR_BAR_KEY, JSON.stringify(cache));
  } catch {
    // Storage blocked: the switches last for this app run only.
  }
  version += 1;
  for (const notify of listeners) notify();
  return next;
}

/** Test seam. */
export function resetPrBarCache(): void {
  cache = null;
}

export function usePrBarSettings(ref: PrRef | null): PrBarSettings {
  useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => version,
    () => version,
  );
  return ref ? prBarSettings(ref) : { ...DEFAULT_PR_BAR };
}

export type AutoFixDecision =
  | { send: true; failed: GithubPrCheck[] }
  | {
      send: false;
      reason:
        | "off"
        | "no-chat"
        | "no-failure"
        | "still-running"
        | "same-commit"
        | "limit";
    };

/**
 * Whether to send the CI repair prompt now. Only when the switch is on, the
 * PR has a chat, at least one check failed, none is still running, the head
 * commit changed since the last repair, and fewer than 2 were sent.
 */
export function decideAutoFix(input: {
  settings: PrBarSettings;
  checks: GithubPrChecks | null;
  hasChat: boolean;
}): AutoFixDecision {
  const { settings, checks } = input;
  if (!settings.autoFix) return { send: false, reason: "off" };
  if (!input.hasChat) return { send: false, reason: "no-chat" };
  if (settings.fixAttempts >= MAX_FIX_ATTEMPTS) return { send: false, reason: "limit" };
  const failed = checks?.checks.filter((check) => check.state === "fail") ?? [];
  if (!checks || failed.length === 0) return { send: false, reason: "no-failure" };
  if (checks.checks.some((check) => check.state === "pending")) {
    return { send: false, reason: "still-running" };
  }
  if (settings.lastFixedHead && settings.lastFixedHead === checks.headOid) {
    return { send: false, reason: "same-commit" };
  }
  return { send: true, failed };
}

/** Archive when the PR is merged or closed, once, with the switch on. */
export function shouldAutoArchive(input: {
  settings: PrBarSettings;
  state: string | undefined;
  hasChat: boolean;
}): boolean {
  const state = input.state?.toLowerCase();
  return (
    input.settings.autoArchive &&
    !input.settings.archived &&
    input.hasChat &&
    (state === "merged" || state === "closed")
  );
}

/** A warning for the auto-fix switch when the chat's model may not manage it. */
export function autoFixWarning(modelId: string | undefined): string | undefined {
  if (modelId && modelCallsToolsReliably(modelId)) return undefined;
  return "This chat's model is not marked as a reliable tool caller, so it may not be able to fix the checks. Set it under Settings, Models.";
}

/** What the app lends the PR bar: sending a repair and archiving a chat. */
export type PrBarHost = {
  /** Send the repair prompt to a chat. False when the chat is busy or gone. */
  submitRepair(sessionId: string, request: CiRepairRequest): Promise<boolean>;
  archiveSession(sessionId: string): Promise<unknown>;
};

let host: PrBarHost | null = null;

export function setPrBarHost(next: PrBarHost | null): void {
  host = next;
}

export function prBarHost(): PrBarHost | null {
  return host;
}
