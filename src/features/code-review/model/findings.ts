import { lineText, type ReviewFile } from "./reviewDiff";

/**
 * Rule 4 of the step 3c plan: ask the model for lines, not JSON or tool
 * calls, parse loosely, and check every claim against the diff.
 */
export type ReviewFinding = {
  path: string;
  /** New-file line the finding is on, or null for the file as a whole. */
  line: number | null;
  comment: string;
  /** The diff line it points at, for the comment card. */
  quote?: string;
  /** True when the model named a line the diff does not show. */
  movedToFile?: boolean;
};

export type ParsedFinding = { path: string; line: number | null; comment: string };

const MAX_COMMENT = 1_000;
const MAX_FINDINGS = 200;

/**
 * One finding per line: `path:line: comment`. Also accepted: a list bullet
 * in front, backticks around the location, `path:line - comment`,
 * `path: comment` for a file-level note, and `path:12-14:` for a range (the
 * first line is kept). Anything else is ignored, including "No findings."
 */
export function parseFindingLines(output: string): ParsedFinding[] {
  const found: ParsedFinding[] = [];
  for (const raw of output.split(/\r?\n/)) {
    if (found.length >= MAX_FINDINGS) break;
    let line = raw.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, "");
    if (!line) continue;
    line = line.replace(/^`([^`]+)`/, "$1");
    const match = line.match(
      /^([^\s:`][^:`]*?):(\d+)(?:\s*[-–]\s*\d+)?\s*(?::|\s[-–]\s)\s*(.+)$/,
    );
    if (match) {
      const comment = match[3].trim().slice(0, MAX_COMMENT);
      if (comment) found.push({ path: match[1].trim(), line: Number(match[2]), comment });
      continue;
    }
    const fileLevel = line.match(/^([^\s:`][^:`]*\.[A-Za-z0-9]+|[^\s:`][^:`]*\/[^:`]*):\s+(.+)$/);
    if (fileLevel) {
      const comment = fileLevel[2].trim().slice(0, MAX_COMMENT);
      if (comment) found.push({ path: fileLevel[1].trim(), line: null, comment });
    }
  }
  return found;
}

function normalisePath(path: string): string {
  return path.replace(/^\.?\//, "").replace(/^[ab]\//, "").trim();
}

/**
 * Keep findings that point into the diff. A finding on a line the diff does
 * not show moves to the file level; a finding on a file not in the diff is
 * dropped. Exact duplicates are dropped.
 */
export function checkFindings(
  parsed: readonly ParsedFinding[],
  files: readonly ReviewFile[],
): { kept: ReviewFinding[]; dropped: number } {
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  const seen = new Set<string>();
  const kept: ReviewFinding[] = [];
  let dropped = 0;
  for (const finding of parsed) {
    const path = normalisePath(finding.path);
    const file =
      byPath.get(path) ??
      files.find((entry) => entry.path.endsWith(`/${path}`) && path.length > 0);
    if (!file) {
      dropped += 1;
      continue;
    }
    let line = finding.line;
    let movedToFile = false;
    if (line !== null && !file.shown.has(line)) {
      line = null;
      movedToFile = true;
    }
    const key = `${file.path}\n${line ?? ""}\n${finding.comment}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const quote = line === null ? undefined : lineText(file, line);
    kept.push({
      path: file.path,
      line,
      comment: finding.comment,
      ...(quote !== undefined ? { quote } : {}),
      ...(movedToFile ? { movedToFile: true } : {}),
    });
  }
  return { kept, dropped };
}

/** A finding as a chat message, in the diff comment format. */
export function formatFindingForChat(finding: ReviewFinding): string {
  const location = (
    finding.line === null ? finding.path : `${finding.path}:${finding.line}`
  ).replace(/`/g, "\\`");
  const lines = [`Review comment on \`${location}\`:`, ""];
  if (finding.quote !== undefined) lines.push(`> ${finding.quote}`, "");
  lines.push(finding.comment);
  return lines.join("\n");
}
