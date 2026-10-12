import type { GitRangeContext } from "../../../platform/tauri/fs";
import type { PrContent } from "./gitText";

/**
 * Pull request text built from the commit range alone, with no model call.
 * Used when no model may see the diff, or when the model gave nothing usable.
 */
export function prContentFromRange(
  range: GitRangeContext,
): PrContent & { base: string; head: string } {
  const commits = range.commitSummary.trim();
  const firstCommit = commits
    .split(/\r?\n/, 1)[0]
    ?.replace(/^[0-9a-f]+\s+/i, "")
    .trim();
  const title = firstCommit || `Changes on ${range.head}`;
  const body = [
    commits && `## Commits\n\n${commits}`,
    range.diffSummary.trim() && `## Changes\n\n${range.diffSummary.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { title, body: body || title, base: range.base, head: range.head };
}
