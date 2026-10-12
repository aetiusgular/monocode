/**
 * #32: the diff a review reads, split per file, with the line numbers each
 * file's hunks cover. Findings are checked against these numbers: a model's
 * claim about a line that is not in the diff is not trusted.
 */
export type ReviewLine = {
  /** Line number in the new file, or null for a deleted line. */
  newNumber: number | null;
  oldNumber: number | null;
  kind: "add" | "del" | "context";
  text: string;
};

export type ReviewFile = {
  /** Repository-relative path of the file after the change. */
  path: string;
  /** This file's part of the patch, from its `diff --git` line. */
  patch: string;
  lines: ReviewLine[];
  /** New-file line numbers shown in the diff (added and context lines). */
  shown: ReadonlySet<number>;
  /** New-file line numbers the change added. */
  added: ReadonlySet<number>;
  deleted: boolean;
};

function unquote(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\t/g, "\t")
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

/** Split a unified patch into files. Text before the first file is ignored. */
export function parseReviewPatch(patch: string): ReviewFile[] {
  const files: ReviewFile[] = [];
  const chunks = patch.split(/^(?=diff --git )/m).filter((chunk) =>
    chunk.startsWith("diff --git "),
  );
  for (const chunk of chunks) {
    const rows = chunk.split("\n");
    let path = "";
    let deleted = false;
    const header = rows[0].match(/^diff --git (?:"?a\/.*?"?) ("?b\/.*"?)$/);
    if (header) path = stripPrefix(unquote(header[1]));
    const lines: ReviewLine[] = [];
    const shown = new Set<number>();
    const added = new Set<number>();
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    for (const row of rows.slice(1)) {
      if (!inHunk) {
        if (row.startsWith("+++ ")) {
          const target = unquote(row.slice(4));
          if (target === "/dev/null") deleted = true;
          else path = stripPrefix(target);
          continue;
        }
        if (row.startsWith("deleted file mode")) deleted = true;
      }
      const hunk = row.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      if (row.startsWith("+")) {
        lines.push({ kind: "add", newNumber: newLine, oldNumber: null, text: row.slice(1) });
        shown.add(newLine);
        added.add(newLine);
        newLine += 1;
      } else if (row.startsWith("-")) {
        lines.push({ kind: "del", newNumber: null, oldNumber: oldLine, text: row.slice(1) });
        oldLine += 1;
      } else if (row.startsWith(" ")) {
        lines.push({ kind: "context", newNumber: newLine, oldNumber: oldLine, text: row.slice(1) });
        shown.add(newLine);
        oldLine += 1;
        newLine += 1;
      } else if (row.startsWith("diff --git ")) {
        break;
      }
    }
    if (!path) continue;
    files.push({ path, patch: chunk, lines, shown, added, deleted });
  }
  return files;
}

/** The text of a new-file line in the diff, if the diff shows it. */
export function lineText(file: ReviewFile, line: number): string | undefined {
  return file.lines.find((entry) => entry.newNumber === line)?.text;
}
