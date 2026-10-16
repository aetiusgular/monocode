import type { ActivityEvent, ApprovalRecord } from "./activityTypes";

/**
 * Wave 3 contract: the TypeScript side of the activity log. Lane B fills
 * these; until then they drop their input. Lanes A and C call them and must
 * not depend on anything being kept.
 *
 * Neither ever throws to its caller: a log that cannot be written must not
 * stop a turn (rules, section 4, case 9).
 */
export function recordActivity(event: ActivityEvent): void {
  void event;
}

/** Records what an approval card, rule or grant allowed. */
export function recordApproval(record: ApprovalRecord): void {
  void record;
}
