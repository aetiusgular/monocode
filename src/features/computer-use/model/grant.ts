/**
 * Wave 3 contract: one app granted to one chat for computer use. Lane C owns
 * it and writes it from the approval card; lane B reads it for the check
 * (each logged action against the grant that covered it at that time).
 */
export type ComputerUseGrant = {
  chatId: string;
  /** The app's bundle id, for example `com.apple.calculator`. */
  bundleId: string;
  /** Milliseconds since the Unix epoch. */
  grantedAt: number;
  /** When the grant ended. Absent while it holds. */
  endedAt?: number;
};

/** True while the grant holds at `at`. */
export function grantHoldsAt(grant: ComputerUseGrant, at: number): boolean {
  return (
    grant.grantedAt <= at && (grant.endedAt === undefined || at < grant.endedAt)
  );
}
