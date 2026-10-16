import { invoke } from "@tauri-apps/api/core";
import type { GithubPrChecks } from "../../inbox/model/githubPrChecks";
import type { MergeMethod } from "../model/prBar";

/** What GitHub said after an auto-merge change, read back from GitHub. */
export type PrAutoMergeResult = {
  /** GitHub's refusal, or gh's error. Inconclusive on its own. */
  refusal?: string | null;
  /** The pull request as GitHub reports it afterwards. */
  pr?: GithubPrChecks | null;
  /** Why the pull request could not be read afterwards. */
  readError?: string | null;
};

/**
 * Turn GitHub's auto-merge on or off for a pull request (#33, Mac 4.10),
 * through GitHub's `enablePullRequestAutoMerge` and
 * `disablePullRequestAutoMerge`, never `gh pr merge --auto`. On names the
 * head commit the bar showed, so GitHub refuses if the branch moved since.
 */
export function setPrAutoMerge(
  cwd: string,
  repo: string,
  number: number,
  change:
    | { enable: true; prId: string; method: MergeMethod; expectedHeadOid: string }
    | { enable: false; prId: string },
): Promise<PrAutoMergeResult> {
  return invoke<PrAutoMergeResult>("git_github_pr_auto_merge", {
    cwd,
    repo,
    number,
    enable: change.enable,
    prId: change.prId,
    method: change.enable ? change.method : null,
    expectedHeadOid: change.enable ? change.expectedHeadOid : null,
  });
}
