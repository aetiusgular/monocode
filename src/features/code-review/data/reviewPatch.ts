import { invoke } from "@tauri-apps/api/core";

export type ReviewPatch = {
  patch: string;
  truncated: boolean;
  skipped: string[];
};

/** The working tree's changes against HEAD, untracked text files included (#32). */
export function loadReviewPatch(cwd: string): Promise<ReviewPatch> {
  return invoke<ReviewPatch>("git_review_patch", { cwd });
}
