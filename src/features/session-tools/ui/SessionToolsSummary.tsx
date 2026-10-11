import type { HarnessId, ToolAccess } from "../../sessions/model/session";
import { sessionToolsSummary } from "../model/harnessInput";

/**
 * Composer pill that stands in for the folder chips and the connectors badge
 * where there is no room for them, so tools a turn is sent with never go
 * unseen. It only reports; the full composer is where they are changed.
 */
export function SessionToolsSummary({
  harness,
  cwd,
  extraDirs,
  disabledMcpServers,
  toolAccess,
  disabledSkills,
  disabledPlugins,
}: {
  harness: HarnessId;
  /** Directory the session works in. */
  cwd: string;
  extraDirs?: string[];
  disabledMcpServers?: string[];
  toolAccess?: ToolAccess;
  disabledSkills?: string[];
  disabledPlugins?: string[];
}) {
  const summary = sessionToolsSummary(
    {
      harness,
      extraDirs,
      disabledMcpServers,
      toolAccess,
      disabledSkills,
      disabledPlugins,
    },
    cwd,
  );
  if (!summary) return null;
  return (
    <span
      title={summary.title}
      data-session-tools-summary
      className="flex h-6.5 shrink-0 items-center gap-1 rounded-md bg-content/5 px-1.5 text-[11px] text-content/70"
    >
      {summary.label}
    </span>
  );
}
