import {
  getAllRateLimits,
  loadRateLimits,
  setCachedRateLimits,
} from "../../providers/model/rateLimitsCache";
import {
  unavailableRateLimits,
  type RateLimitProvider,
} from "../../providers/model/rateLimits";
import {
  OUTBOUND_CALL_OFF_MESSAGE,
  setOutboundCallAllowed,
  type OutboundCallId,
} from "../../settings/model/outboundCalls";

const USAGE_PROVIDERS: readonly RateLimitProvider[] = [
  "claude",
  "codex",
  "opencode",
  "devin",
];

/**
 * Flip one switch. Turning usage back on reloads each usage snapshot that the
 * switch had blocked, so the meters do not keep saying the call is off. The
 * other calls resume on their own: link previews and the star check re-render
 * from the switch, and the version check runs when its notice next mounts.
 */
export function setOutboundCall(id: OutboundCallId, allowed: boolean): void {
  setOutboundCallAllowed(id, allowed);
  if (id === "usage" && allowed) resumeBlockedUsage();
  if (id === "usage" && !allowed) clearSwitchedOffUsage();
}

/** The providers whose usage the switch covers. Codex reports through its own process. */
const SWITCHED_PROVIDERS: readonly RateLimitProvider[] = [
  "claude",
  "opencode",
  "devin",
];

/**
 * Turning usage off replaces each figure fetched before with the off state at
 * once, so the footer stops showing old percentages and an "Updated" time
 * (Mac 5.9).
 */
export function clearSwitchedOffUsage(): void {
  for (const key of Object.keys(getAllRateLimits())) {
    const split = key.indexOf(":");
    if (split <= 0) continue;
    const provider = key.slice(0, split) as RateLimitProvider;
    if (!SWITCHED_PROVIDERS.includes(provider)) continue;
    const accountId = key.slice(split + 1) || "default";
    setCachedRateLimits(
      provider,
      accountId,
      unavailableRateLimits(provider, OUTBOUND_CALL_OFF_MESSAGE),
    );
  }
}

export function resumeBlockedUsage(): Promise<unknown> {
  const jobs: Promise<unknown>[] = [];
  for (const [key, limits] of Object.entries(getAllRateLimits())) {
    if (limits.status !== "unavailable") continue;
    if (limits.error !== OUTBOUND_CALL_OFF_MESSAGE) continue;
    const split = key.indexOf(":");
    if (split <= 0) continue;
    const provider = key.slice(0, split) as RateLimitProvider;
    if (!USAGE_PROVIDERS.includes(provider)) continue;
    const accountId = key.slice(split + 1) || "default";
    jobs.push(loadRateLimits(provider, accountId, true).catch(() => undefined));
  }
  return Promise.all(jobs);
}
