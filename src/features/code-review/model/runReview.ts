import {
  GIT_TIMEOUT_MS,
  canRunHelper,
  isHelperRoute,
  runHelperPrompt,
  type HelperRoute,
  type HelperTarget,
} from "../../../integrations/harness/core/helperPrompt";
import { modelBudgetWindow } from "../../model-traits/model/modelTraits";
import { harnessIsHosted, type Locality } from "../../server-locality/model/locality";
import { providerLocality } from "../../model-setup/model/providerLocality";
import { loadReviewPatch, type ReviewPatch } from "../data/reviewPatch";
import { checkFindings, parseFindingLines, type ReviewFinding } from "./findings";
import { chunkBudgetChars, reviewChunks, type ReviewChunk } from "./reviewChunks";
import { parseReviewPatch, type ReviewFile } from "./reviewDiff";

export function asRoute(target: HelperTarget): HelperRoute {
  return isHelperRoute(target) ? target : { kind: "route", harness: target };
}

/** Where a reviewer sends the diff: its model route only. */
export function reviewerLocality(target: HelperTarget): Locality {
  const route = asRoute(target);
  if (harnessIsHosted(route.harness)) return "hosted";
  return providerLocality(route.modelProvider);
}

/** True when two routes send content to the same place. */
export function sameRoute(a: HelperTarget, b: HelperTarget): boolean {
  const left = asRoute(a);
  const right = asRoute(b);
  return (
    left.harness === right.harness &&
    (left.providerAccountId ?? "") === (right.providerAccountId ?? "") &&
    (left.modelId ?? "") === (right.modelId ?? "") &&
    (left.modelProvider ?? "") === (right.modelProvider ?? "")
  );
}

export function buildReviewPrompt(chunk: ReviewChunk, part: number, parts: number): string {
  return [
    "You are reviewing a code change. Read the diff below and report real problems only: bugs, security issues, broken edge cases, missing error handling, and clear mistakes.",
    "",
    "Write one finding per line, in exactly this form:",
    "path/to/file.ext:LINE: what is wrong and how to fix it",
    "",
    "LINE is the line number in the new version of the file, from the + side of the diff.",
    "For a problem with the whole file, write: path/to/file.ext: comment",
    "Write nothing else: no headings, no summary, no code blocks. If there is nothing to report, write: No findings.",
    "",
    parts > 1 ? `This is part ${part} of ${parts} of the diff.` : "",
    chunk.cut.length
      ? `These files were cut to fit and end early: ${chunk.cut.join(", ")}.`
      : "",
    "",
    "Diff:",
    chunk.text,
  ]
    .filter((line, index, all) => line !== "" || all[index - 1] !== "")
    .join("\n");
}

export type ReviewProgress = { done: number; total: number };

export type ReviewResult = {
  findings: ReviewFinding[];
  /** Findings the model gave for files not in the diff. */
  dropped: number;
  /** Chunks the model failed on, with the reason. */
  failures: string[];
  chunks: number;
  files: number;
  truncated: boolean;
  skipped: string[];
};

/**
 * Review the working tree of `cwd` with `reviewer` (#32). The diff is cut into
 * per-file chunks under 40% of the reviewer model's window, each sent as a
 * helper prompt on the reviewer's own harness and account (F6). Each answer
 * is parsed line by line and checked against the diff.
 */
export async function runReview(input: {
  cwd: string;
  reviewer: HelperTarget;
  signal?: AbortSignal;
  onProgress?: (progress: ReviewProgress) => void;
  /** Test seam. */
  loadPatch?: (cwd: string) => Promise<ReviewPatch>;
}): Promise<ReviewResult> {
  const route = asRoute(input.reviewer);
  if (!canRunHelper(route)) {
    throw new Error(
      `${route.harness} cannot run a review on the side. Pick another reviewer.`,
    );
  }
  const loaded = await (input.loadPatch ?? loadReviewPatch)(input.cwd);
  const files: ReviewFile[] = parseReviewPatch(loaded.patch);
  if (files.length === 0) {
    return {
      findings: [],
      dropped: 0,
      failures: [],
      chunks: 0,
      files: 0,
      truncated: loaded.truncated,
      skipped: loaded.skipped,
    };
  }
  const window = route.modelId ? modelBudgetWindow(route.modelId) : undefined;
  const chunks = reviewChunks(files, chunkBudgetChars(window));
  const findings: ReviewFinding[] = [];
  const failures: string[] = [];
  let dropped = 0;
  input.onProgress?.({ done: 0, total: chunks.length });
  for (const [index, chunk] of chunks.entries()) {
    input.signal?.throwIfAborted();
    try {
      const output = await runHelperPrompt(route, {
        cwd: input.cwd,
        prompt: buildReviewPrompt(chunk, index + 1, chunks.length),
        baseTimeoutMs: GIT_TIMEOUT_MS,
        signal: input.signal,
      });
      const chunkFiles = files.filter((file) => chunk.paths.includes(file.path));
      const checked = checkFindings(parseFindingLines(output), chunkFiles);
      findings.push(...checked.kept);
      dropped += checked.dropped;
    } catch (error) {
      if (input.signal?.aborted) throw error;
      failures.push(
        `${chunk.paths.join(", ")}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    input.onProgress?.({ done: index + 1, total: chunks.length });
  }
  return {
    findings,
    dropped,
    failures,
    chunks: chunks.length,
    files: files.length,
    truncated: loaded.truncated,
    skipped: loaded.skipped,
  };
}
