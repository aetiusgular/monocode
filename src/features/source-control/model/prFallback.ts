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
  // `commitSummary` is `git log --format=%s`: subjects only, newest first, no
  // hash. Mac test 4.4: stripping a leading hash cut "Add" (all hex letters)
  // from "Add a retest line to the README".
  const firstCommit = commits.split(/\r?\n/, 1)[0]?.trim();
  const title = firstCommit || `Changes on ${range.head}`;
  const body = [
    commits && `## Commits\n\n${commits}`,
    range.diffSummary.trim() && `## Changes\n\n${range.diffSummary.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { title, body: body || title, base: range.base, head: range.head };
}
