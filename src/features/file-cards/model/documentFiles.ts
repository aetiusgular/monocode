import { isEditTool } from "../../../integrations/harness/core/preview";
import { displayPath, pathKey, prettyCwd } from "../../../shared/lib/paths";
import { REMOTE_PATH_PREFIX } from "../../../shared/lib/remotePaths";
import { leafName, pathSegments } from "../../files/model/fileName";
import type {
  AgentStep,
  Block,
  ToolPreview,
} from "../../sessions/model/session";
import {
  isToolBlock,
  resolveToolCallDisplay,
  toolCallLabel,
  toolCallState,
} from "../../sessions/model/transcriptActivity";

/** Extensions of files that read as a document the agent hands over. */
export const DOCUMENT_EXTENSIONS = [
  "md",
  "mdx",
  "markdown",
  "txt",
  "rst",
  "adoc",
  "pdf",
  "docx",
  "csv",
  "tsv",
  "html",
] as const;

export type DocumentExtension = (typeof DOCUMENT_EXTENSIONS)[number];

/** Folders whose contents are build output or tooling, never a deliverable. */
export const EXCLUDED_DOCUMENT_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
] as const;

/** Cards shown under one turn before the rest fold behind "+N more". */
export const MAX_DOCUMENT_CARDS = 6;

const TYPE_LABEL: Record<DocumentExtension, string> = {
  md: "Document · MD",
  mdx: "Document · MDX",
  markdown: "Document · MD",
  txt: "Document · TXT",
  rst: "Document · RST",
  adoc: "Document · ADOC",
  pdf: "Document · PDF",
  docx: "Document · DOCX",
  csv: "Table · CSV",
  tsv: "Table · TSV",
  html: "Page · HTML",
};

/**
 * File names that are generated state or configuration whatever their
 * extension: lockfiles, and the plain-text manifests build tools read.
 */
const NON_DELIVERABLE_NAMES = [
  /\.lockb?$/i,
  /[-_.]lock\.(?:json|ya?ml|toml)$/i,
  /^(?:cmakelists|robots)\.txt$/i,
  /^(?:requirements|constraints)(?:[-_.][\w.-]*)?\.txt$/i,
];

export type DocumentFile = {
  /** Absolute path, resolved the way the transcript's own file rows open it. */
  path: string;
  /** Last path segment. */
  name: string;
  /** Path inside the working directory, or home-shortened outside it. */
  relativePath: string;
  extension: DocumentExtension;
  /** Muted label beside the name, e.g. "Document · MD". */
  typeLabel: string;
};

export type DocumentCollectOptions = {
  /** The session's working directory. */
  cwd?: string;
  /** The turn is still running: only calls that reported completion count. */
  live?: boolean;
  /** Also card documents that were only partially edited. Off by default. */
  includeEdits?: boolean;
};

/** The document extension of a path, when it has one. */
export function documentExtension(path: string): DocumentExtension | undefined {
  const extension = /.\.([A-Za-z0-9]+)$/
    .exec(leafName(path))?.[1]
    .toLowerCase();
  return DOCUMENT_EXTENSIONS.find((entry) => entry === extension);
}

/** Muted type label for a document path, e.g. "Document · MD". */
export function documentTypeLabel(path: string): string {
  const extension = documentExtension(path);
  return extension ? TYPE_LABEL[extension] : "File";
}

/** Path shown under the name: relative inside `cwd`, home-shortened outside. */
export function documentRelativePath(path: string, cwd?: string): string {
  const shown = displayPath(path, cwd);
  return shown === displayPath(path) ? prettyCwd(shown) : shown;
}

/**
 * True for build output, dependency and VCS folders, and lockfiles. Folders
 * are judged below `cwd`, so a project that itself lives under a folder named
 * `build` keeps its documents.
 */
export function isExcludedDocumentPath(path: string, cwd?: string): boolean {
  const segments = pathSegments(displayPath(path, cwd));
  const name = segments.pop() ?? "";
  if (NON_DELIVERABLE_NAMES.some((pattern) => pattern.test(name))) return true;
  return segments.some((segment) =>
    EXCLUDED_DOCUMENT_DIRS.some((dir) => dir === segment.toLowerCase()),
  );
}

/**
 * Documents the agent wrote during one turn, in the order it first wrote
 * them, one entry per file.
 *
 * A write counts once its tool call landed: not denied, not failed, and in a
 * live turn only after the call reported completion. Whole-file writes and
 * creations count. A call whose preview shows it changed part of an existing
 * file does not, unless something else in the turn wrote that file whole;
 * when a harness gives no evidence either way the document is included.
 */
export function collectTurnDocuments(
  blocks: readonly Block[],
  options: DocumentCollectOptions = {},
): DocumentFile[] {
  const { cwd, live = false, includeEdits = false } = options;
  const found = new Map<string, { file: DocumentFile; partial: boolean }>();
  for (const block of writeCalls(blocks)) {
    if (!writeLanded(block, live)) continue;
    const kind = block.tool?.kind?.trim().toLowerCase();
    if (kind === "delete" || kind === "move") continue;
    const preview = block.tool?.preview;
    const display = resolveToolCallDisplay(
      toolCallLabel(block, cwd),
      preview,
      cwd,
    );
    // A row whose label and preview name different files is ambiguous about
    // which one was written, so it is left to the row itself.
    if (!display.isFile || !display.filePath || !display.previewMatchesFile) {
      continue;
    }
    const { action, filePath: path } = display;
    if (action !== "Edit" && action !== "Write" && action !== "Create") {
      continue;
    }
    if (path.startsWith(REMOTE_PATH_PREFIX)) continue;
    const extension = documentExtension(path);
    if (!extension || isExcludedDocumentPath(path, cwd)) continue;
    const partial = action === "Edit" && isPartialEdit(preview);
    const key = pathKey(path);
    const earlier = found.get(key);
    if (earlier) {
      if (!partial) earlier.partial = false;
      continue;
    }
    found.set(key, {
      file: {
        path,
        name: leafName(path),
        relativePath: documentRelativePath(path, cwd),
        extension,
        typeLabel: TYPE_LABEL[extension],
      },
      partial,
    });
  }
  return [...found.values()]
    .filter((entry) => includeEdits || !entry.partial)
    .map((entry) => entry.file);
}

/** The cards to show now, and how many more the "+N more" row stands for. */
export function documentCardWindow<T>(
  files: readonly T[],
  expanded: boolean,
  max = MAX_DOCUMENT_CARDS,
): { visible: T[]; hidden: number } {
  const visible = expanded ? files.slice() : files.slice(0, max);
  return { visible, hidden: files.length - visible.length };
}

/** File-writing calls of a turn, including those of its delegated runs. */
function writeCalls(blocks: readonly Block[]): Block[] {
  return blocks
    .flatMap((block) => [
      ...(isToolBlock(block) ? [block] : []),
      ...(block.agentRun?.steps ?? []).flatMap(stepBlock),
    ])
    .filter((block) =>
      isEditTool(
        block.tool?.kind,
        block.text || block.tool?.title,
        block.tool?.preview,
      ),
    );
}

/** A subagent's mirrored tool step, in the shape of the block it stands for. */
function stepBlock(step: AgentStep): Block[] {
  if (step.kind !== "tool") return [];
  return [
    {
      id: step.id,
      role: "tool",
      text: step.text,
      tool: {
        title: step.text,
        ...(step.toolKind ? { kind: step.toolKind } : {}),
        ...(step.status ? { status: step.status } : {}),
        ...(step.preview ? { preview: step.preview } : {}),
      },
    },
  ];
}

function writeLanded(block: Block, live: boolean): boolean {
  if (toolCallState(block) !== "accepted") return false;
  if (!live) return true;
  const status = block.tool?.status?.toLowerCase();
  return status === "completed" || status === "success";
}

/**
 * Evidence that a write changed part of a file that already existed: removed
 * lines, unchanged context around the change, or additions that start below
 * the first line. A preview without a diff proves nothing either way.
 */
function isPartialEdit(preview: ToolPreview | undefined): boolean {
  if (!preview || preview.contentOnly) return false;
  if ((preview.deletions ?? 0) > 0) return true;
  const lines = preview.lines ?? [];
  if (lines.some((line) => line.kind !== "add")) return true;
  const first = lines[0]?.number;
  return first != null && first > 1;
}
