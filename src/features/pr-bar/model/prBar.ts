import { useSyncExternalStore } from "react";
import type { GithubPrCheck, GithubPrChecks } from "../../inbox/model/githubPrChecks";
import type { CiRepairRequest } from "../../inbox/model/ciRepair";
import { modelCallsToolsReliably } from "../../model-traits/model/modelTraits";

/**
 * #33: the PR bar's switches for one pull request. Auto-merge is GitHub's own
 * auto-merge request, set through GitHub's `enablePullRequestAutoMerge`; the
 * switch shows what GitHub reports, never a stored value, because GitHub
 * clears it by itself after some pushes and base changes (Mac 4.10, retest 3).
 * Auto-archive archives the PR's chat once the PR is merged or closed.
 * Auto-fix sends the CI repair prompt to the PR's chat when checks fail: off
 * by default, at most 2 tries, never twice for one commit.
 */
export type MergeMethod = "merge" | "squash" | "rebase";

export type PrBarSettings = {
  /** The merge method to use when auto-merge is turned on. Only a preference. */
  mergeMethod?: MergeMethod;
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
  // `autoMerge` held the method when the switch was stored here; it is read
  // once as the preferred method and never as "on".
  const method = record.mergeMethod ?? record.autoMerge;
  const attempts = Number(record.fixAttempts);
  return {
    ...(method === "merge" || method === "squash" || method === "rebase"
      ? { mergeMethod: method }
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

/** What the auto-merge row shows, from what GitHub reports for the PR. */
export type AutoMergeView =
  /** No read of the PR yet: the switch waits. */
  | { kind: "unknown" }
  /** GitHub has an auto-merge request. */
  | { kind: "on"; method?: MergeMethod; text: string }
  /** GitHub would accept one: the switch is offered. */
  | { kind: "available" }
  /** Nothing to wait for: GitHub would merge now, so there is no switch. */
  | { kind: "merge-now"; text: string }
  | { kind: "draft"; text: string };

export const MERGE_NOW_TEXT =
  "Nothing to wait for: GitHub would merge this PR now. Merge it on GitHub.";
export const UNSTABLE_TEXT = "A check that is not required is failing.";
export const DRAFT_TEXT = "Drafts can't auto-merge.";
export const AUTO_MERGE_NOT_ALLOWED_TEXT =
  "Auto-merge is off for this repository on GitHub (Settings, General, Allow auto-merge).";

export function mergeMethodFromGithub(value: string | null | undefined): MergeMethod | undefined {
  switch (value?.toUpperCase()) {
    case "MERGE":
      return "merge";
    case "SQUASH":
      return "squash";
    case "REBASE":
      return "rebase";
    default:
      return undefined;
  }
}

export function autoMergeOnText(method: MergeMethod | undefined): string {
  return `Auto-merge is on (${method ?? "GitHub's default method"}). GitHub merges this PR when its required checks and reviews pass.`;
}

/**
 * The auto-merge row for a PR, from GitHub's own fields. `gh pr merge --auto`
 * merged at once for `CLEAN`, `HAS_HOOKS` and `UNSTABLE`, and GitHub's own
 * auto-merge is offered only on a PR that cannot merge now, so those get no
 * switch: there is nothing to wait for. An existing request always shows,
 * so it can be turned off.
 */
export function autoMergeView(checks: GithubPrChecks | null): AutoMergeView {
  if (!checks || !checks.prId) return { kind: "unknown" };
  if (checks.state && checks.state.toUpperCase() !== "OPEN") return { kind: "unknown" };
  if (checks.autoMergeRequest) {
    const method = mergeMethodFromGithub(checks.autoMergeRequest.mergeMethod);
    return { kind: "on", method, text: autoMergeOnText(method) };
  }
  const status = checks.mergeStateStatus?.toUpperCase();
  if (checks.isDraft || status === "DRAFT") return { kind: "draft", text: DRAFT_TEXT };
  if (status === "CLEAN" || status === "HAS_HOOKS") {
    return { kind: "merge-now", text: MERGE_NOW_TEXT };
  }
  if (status === "UNSTABLE") {
    return { kind: "merge-now", text: `${MERGE_NOW_TEXT} ${UNSTABLE_TEXT}` };
  }
  return { kind: "available" };
}

/**
 * A refusal from GitHub, for the bar. The repository setting gets a pointer
 * to where it is switched on; any other refusal is shown in GitHub's words.
 */
export function autoMergeRefusalText(raw: string): string {
  const text = raw.trim();
  if (/auto[ -]?merge is not allowed|not allowed for this repository/i.test(text)) {
    return AUTO_MERGE_NOT_ALLOWED_TEXT;
  }
  return text;
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
        | "limit"
        | "not-open";
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
  // Only an open PR gets a repair, as GitHub reports it (review H1).
  if (checks?.state && checks.state.toUpperCase() !== "OPEN") {
    return { send: false, reason: "not-open" };
  }
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

/** A read of the PR's checks: what it asked for, and when it answered. */
export type PrChecksRead = {
  checks: GithubPrChecks | null;
  /** The PR number the read asked GitHub for. */
  number: number | null;
  /** When it answered. Null for checks that were not read in this run. */
  at: number | null;
};

const PR_STATES = ["open", "closed", "merged"] as const;
export type PrState = (typeof PR_STATES)[number];

/**
 * The state a checks read reports for the bar's PR, or null. Only for the
 * PR the bar shows: the read asked for its number, and GitHub's answer names
 * that number or none. The state, head and checks the bar shows then all
 * come from this one read.
 */
export function checksStateFor(number: number, read: PrChecksRead): PrState | null {
  const { checks } = read;
  if (!checks || read.number !== number) return null;
  if (checks.number != null && checks.number !== number) return null;
  const state = checks.state?.trim().toLowerCase();
  return PR_STATES.find((known) => known === state) ?? null;
}

/**
 * The PR's state as the bar shows it (Mac 4.10, 16 Oct). After auto-merge
 * merged PR #3, the bar showed it open with its switches for minutes: it
 * took the state from the PR lookup, which runs on focus or an action, while
 * the checks read already said MERGED. Now the newer of the two reads wins.
 * A merged PR never opens again, so merged from either read stands.
 */
export function prBarState(input: {
  number: number;
  /** `pr.state` from the PR lookup. */
  lookupState: string;
  /** When the lookup last answered. */
  lookupAt: number | null;
  read: PrChecksRead;
}): string {
  const fromLookup = input.lookupState.trim().toLowerCase();
  const reported = checksStateFor(input.number, input.read);
  if (!reported) return fromLookup;
  if (fromLookup === "merged" || reported === "merged") return "merged";
  if (input.read.at == null) return fromLookup;
  if (input.lookupAt == null || input.read.at >= input.lookupAt) return reported;
  return fromLookup;
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
