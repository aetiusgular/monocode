import type { HelperTarget } from "../../../integrations/harness/core/helperPrompt";
import { pathKey } from "../../../shared/lib/paths";
import { reviewerLocality, sameRoute } from "./runReview";

/**
 * #32 privacy: a review that sends the diff anywhere but the session's own
 * route, to a reviewer that is not local, asks once per project. "Unknown"
 * counts as hosted. Your yes is kept per project folder.
 */
export const REVIEW_CONSENT_KEY = "monocode.reviewConsent";
const MAX_PROJECTS = 200;

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function load(): string[] {
  try {
    const raw = storage()?.getItem(REVIEW_CONSENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string").slice(0, MAX_PROJECTS)
      : [];
  } catch {
    return [];
  }
}

export function reviewConsented(project: string): boolean {
  return load().includes(pathKey(project));
}

export function recordReviewConsent(project: string): void {
  const key = pathKey(project);
  const current = load().filter((item) => item !== key);
  const next = [key, ...current].slice(0, MAX_PROJECTS);
  try {
    storage()?.setItem(REVIEW_CONSENT_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: you are asked again next time.
  }
}

export function forgetReviewConsent(project: string): void {
  const key = pathKey(project);
  try {
    storage()?.setItem(
      REVIEW_CONSENT_KEY,
      JSON.stringify(load().filter((item) => item !== key)),
    );
  } catch {
    // Nothing to forget.
  }
}

/** Whether this review must ask before the diff leaves for the reviewer. */
export function reviewNeedsConsent(input: {
  project: string;
  owner: HelperTarget | undefined;
  reviewer: HelperTarget;
}): boolean {
  if (input.owner && sameRoute(input.owner, input.reviewer)) return false;
  if (reviewerLocality(input.reviewer) === "local") return false;
  return !reviewConsented(input.project);
}
