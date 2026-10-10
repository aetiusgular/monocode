import { pathKey, prettyCwd, projectName } from "../../../shared/lib/paths";
import {
  collectTurnDocuments,
  type DocumentFile,
} from "../../file-cards/model/documentFiles";
import {
  sessionWorkCwd,
  type AttachmentKind,
  type Block,
  type Session,
} from "../../sessions/model/session";

type BlockDocuments = {
  cwd: string | undefined;
  live: boolean;
  /** Every document the block's calls touched, part-edits included. */
  all: DocumentFile[];
  /** The ones it wrote whole, by path key. */
  whole: Set<string>;
};

/**
 * Blocks are replaced, never mutated, so a block read before yields the same
 * documents again. Without this a long session would re-read every tool call
 * on each streamed token, and it does so even while the panel is shut, to keep
 * the count on its button.
 */
const documentsByBlock = new WeakMap<Block, BlockDocuments>();

function blockDocuments(
  block: Block,
  cwd: string | undefined,
  live: boolean,
): BlockDocuments {
  const cached = documentsByBlock.get(block);
  if (cached && cached.cwd === cwd && cached.live === live) return cached;
  const all = collectTurnDocuments([block], { cwd, live, includeEdits: true });
  const whole =
    all.length === 0 ? [] : collectTurnDocuments([block], { cwd, live });
  const read: BlockDocuments = {
    cwd,
    live,
    all,
    whole: new Set(whole.map((file) => pathKey(file.path))),
  };
  documentsByBlock.set(block, read);
  return read;
}

/**
 * Where the turn in hand begins: the last message the user sent to start one.
 * A message that joined a turn already running does not start another.
 */
function runningTurnStart(blocks: readonly Block[]): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.role === "user" && block.sentAt == null) return index;
  }
  return 0;
}

/**
 * Documents the agent wrote anywhere in the session, in the order it first
 * wrote them. The same rule as the cards under each turn, read across turns:
 * a document counts once something wrote it whole. While the session is busy,
 * only the turn in hand waits for its calls to report completion; a settled
 * turn's writes have landed whatever their rows say.
 */
export function sessionOutputs(
  blocks: readonly Block[],
  options: { cwd?: string; live?: boolean } = {},
): DocumentFile[] {
  const { cwd, live = false } = options;
  const liveFrom = live ? runningTurnStart(blocks) : blocks.length;
  const found = new Map<string, { file: DocumentFile; whole: boolean }>();
  blocks.forEach((block, index) => {
    if (!block.tool && !block.agentRun) return;
    const documents = blockDocuments(block, cwd, index >= liveFrom);
    for (const file of documents.all) {
      const key = pathKey(file.path);
      const whole = documents.whole.has(key);
      const earlier = found.get(key);
      if (earlier) {
        if (whole) earlier.whole = true;
      } else found.set(key, { file, whole });
    }
  });
  return [...found.values()]
    .filter((entry) => entry.whole)
    .map((entry) => entry.file);
}

/** Short type tag for an output row, e.g. "MD". */
export function outputTag(file: Pick<DocumentFile, "extension">): string {
  return file.extension.toUpperCase();
}

export type SessionAttachment = {
  /** Unique within the session. */
  key: string;
  name: string;
  kind: AttachmentKind;
  /** Absolute path when the file lives on disk. */
  path?: string;
  /** Thumbnail for an image attached in this run of the app. */
  previewUrl?: string;
  /** The user message it was sent with. */
  blockId: string;
};

/** Everything the user attached to their messages, oldest first. */
export function sessionAttachments(
  blocks: readonly Block[],
): SessionAttachment[] {
  const found: SessionAttachment[] = [];
  for (const block of blocks) {
    if (block.role !== "user" || block.internal) continue;
    for (const attachment of block.attachments ?? []) {
      found.push({
        key: `${block.id}:${attachment.id}`,
        name: attachment.name,
        kind: attachment.kind,
        blockId: block.id,
        ...(attachment.path ? { path: attachment.path } : {}),
        ...(attachment.previewUrl ? { previewUrl: attachment.previewUrl } : {}),
      });
    }
  }
  return found;
}

export type SessionFolder = {
  path: string;
  /** Last path segment. */
  name: string;
  /** Home-shortened path. */
  shown: string;
  role: "working" | "added";
};

/** The folder the session works in, then the folders added to it. */
export function sessionFolders(
  session: Pick<Session, "cwd" | "worktreeCwd" | "extraDirs">,
): SessionFolder[] {
  const workCwd = sessionWorkCwd(session);
  const folders: SessionFolder[] = [];
  const seen = new Set<string>();
  const add = (path: string, role: SessionFolder["role"]) => {
    const key = pathKey(path);
    if (!path || seen.has(key)) return;
    seen.add(key);
    folders.push({
      path,
      name: projectName(path),
      shown: prettyCwd(path),
      role,
    });
  };
  if (workCwd) add(workCwd, "working");
  for (const dir of session.extraDirs ?? []) add(dir, "added");
  return folders;
}

/** First name plus how many more there are, for a one-line preview. */
export function previewOf(names: readonly string[]): {
  first: string;
  more: number;
} {
  return { first: names[0] ?? "", more: Math.max(0, names.length - 1) };
}
