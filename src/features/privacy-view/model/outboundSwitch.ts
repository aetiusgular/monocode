import {
  getAllRateLimits,
  loadRateLimits,
} from "../../providers/model/rateLimitsCache";
import type { RateLimitProvider } from "../../providers/model/rateLimits";
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
