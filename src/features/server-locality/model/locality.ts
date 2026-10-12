import type { Session } from "../../sessions/model/session";

/**
 * Where a session's content goes: only to this Mac, to a hosted service, or
 * not known. Callers treat "unknown" as hosted, everywhere.
 */
export type Locality = "local" | "hosted" | "unknown";

/** The session fields a locality decision may read. */
export type LocalitySession = Pick<Session, "harness"> &
  Partial<
    Pick<
      Session,
      | "model"
      | "modelProvider"
      | "providerAccountId"
      | "disabledMcpServers"
      | "disabledSkills"
    >
  >;

/**
 * Contract for the parallel build, filled by lane 4 (#9). A session is local
 * only when its model route, its harness home and every enabled tool are
 * local. Until then: Claude Code is hosted, every other harness unknown.
 */
export function sessionIsLocal(session: LocalitySession): Locality {
  return session.harness === "claude" ? "hosted" : "unknown";
}

/** Whether a locality counts as local. "unknown" never does. */
export function isLocal(locality: Locality): boolean {
  return locality === "local";
}
