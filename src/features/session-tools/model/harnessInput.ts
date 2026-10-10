import type { Session } from "../../sessions/model/session";
import { harnessDisabledMcpServers } from "./connectors";
import { harnessExtraDirs } from "./extraDirs";

/**
 * A session's composer tools in the shape a harness turn takes. Every call
 * that can start a harness process (send, rewind, compact) must pass the same
 * value: Claude Code and Codex reopen the conversation whenever these launch
 * inputs differ.
 */
export function sessionToolsInput(
  session: Pick<Session, "harness" | "extraDirs" | "disabledMcpServers">,
  workCwd: string,
): { extraDirs?: string[]; disabledMcpServers?: string[] } {
  const extraDirs = harnessExtraDirs(
    session.harness,
    session.extraDirs,
    workCwd,
  );
  const disabledMcpServers = harnessDisabledMcpServers(
    session.harness,
    session.disabledMcpServers,
  );
  return {
    ...(extraDirs ? { extraDirs } : {}),
    ...(disabledMcpServers ? { disabledMcpServers } : {}),
  };
}

/** The session with its extra folders replaced; an empty list clears them. */
export function withExtraDirs<T extends Pick<Session, "extraDirs">>(
  session: T,
  dirs: string[],
): T {
  return { ...session, extraDirs: dirs.length > 0 ? dirs : undefined };
}

/** The session with its switched-off MCP servers replaced, likewise. */
export function withDisabledMcpServers<
  T extends Pick<Session, "disabledMcpServers">,
>(session: T, names: string[]): T {
  return {
    ...session,
    disabledMcpServers: names.length > 0 ? names : undefined,
  };
}

/**
 * The tools a turn is sent with, in a few words, for a composer too small for
 * the folder chips and the connectors badge. `title` lists each folder's path
 * and each switched-off server. Null when a turn is sent with neither.
 */
export function sessionToolsSummary(
  session: Pick<Session, "harness" | "extraDirs" | "disabledMcpServers">,
  workCwd: string,
): { label: string; title: string } | null {
  const { extraDirs = [], disabledMcpServers = [] } = sessionToolsInput(
    session,
    workCwd,
  );
  const parts: string[] = [];
  const lines: string[] = [];
  if (extraDirs.length > 0) {
    parts.push(
      `${extraDirs.length} ${extraDirs.length === 1 ? "folder" : "folders"}`,
    );
    lines.push("Extra folders:", ...extraDirs);
  }
  if (disabledMcpServers.length > 0) {
    parts.push(`${disabledMcpServers.length} off`);
    lines.push(`Connectors off: ${disabledMcpServers.join(", ")}`);
  }
  return parts.length > 0
    ? { label: parts.join(" · "), title: lines.join("\n") }
    : null;
}
