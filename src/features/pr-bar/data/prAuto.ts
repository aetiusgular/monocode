import { invoke } from "@tauri-apps/api/core";

/** The auto-merge actions the Rust allowlist takes (#33). */
export type PrAutoAction = "auto-merge" | "auto-squash" | "auto-rebase" | "disable-auto";

/** Turn GitHub's auto-merge on or off for a pull request, through `gh`. */
export function setPrAutoMerge(
  cwd: string,
  repo: string,
  number: number,
  action: PrAutoAction,
): Promise<unknown> {
  return invoke("git_github_pr_action", { cwd, repo, number, action });
}
