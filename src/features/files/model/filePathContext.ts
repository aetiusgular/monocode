import { formatFileReference } from "./editorSelection";

/**
 * The text "Add to chat" puts in the composer for a file or folder (#50).
 *
 * A file inside the project becomes an `@relative/path` mention, which
 * MonoCode expands itself for every harness, so any model gets the file
 * without a tool call. A folder, or a file outside the project or with a
 * name a mention cannot carry (spaces, `@`, a leading dash is fine), becomes
 * its path in backticks.
 */
export function formatPathContext(
  path: string,
  cwd: string | undefined,
  isDir = false,
): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const root = (cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const relative =
    root && normalized.startsWith(`${root}/`)
      ? normalized.slice(root.length + 1)
      : normalized;
  if (isDir) {
    const label = relative === root || !relative ? "." : relative;
    return `\`${label.replace(/[`\r\n]/g, "'")}/\``;
  }
  return formatFileReference(relative);
}

/** Several selected entries, one per line. Duplicates are dropped. */
export function formatPathsContext(
  entries: Array<{ path: string; isDir: boolean }>,
  cwd: string | undefined,
): string {
  const lines = new Set<string>();
  for (const entry of entries) lines.add(formatPathContext(entry.path, cwd, entry.isDir));
  return [...lines].join("\n");
}
