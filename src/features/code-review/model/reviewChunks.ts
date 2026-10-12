import type { ReviewFile } from "./reviewDiff";

/**
 * Rule 5 of the step 3c plan: a review chunk is at most 40% of the model's
 * context window. 4 characters a token. A window nobody knows is taken as
 * 16,384 tokens, the local model's, so an unknown model is never overfed.
 */
export const CHUNK_SHARE = 0.4;
export const CHARS_PER_TOKEN = 4;
export const UNKNOWN_WINDOW = 16_384;
/** Room the instructions and file list take, in characters. */
export const PROMPT_OVERHEAD_CHARS = 1_600;
/** No chunk is smaller than this, whatever the window says. */
const MIN_CHUNK_CHARS = 2_000;

export function chunkBudgetChars(contextWindow: number | undefined): number {
  const window =
    contextWindow && Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : UNKNOWN_WINDOW;
  const chars = Math.floor(window * CHUNK_SHARE * CHARS_PER_TOKEN) - PROMPT_OVERHEAD_CHARS;
  return Math.max(MIN_CHUNK_CHARS, chars);
}

export type ReviewChunk = {
  /** Paths whose patch is in this chunk, in order. */
  paths: string[];
  text: string;
  /** Paths cut short to fit: the model saw only their start. */
  cut: string[];
};

/**
 * Pack whole files into chunks under the budget, in diff order. A file
 * larger than a chunk is split at hunk boundaries; a single hunk larger than
 * a chunk is cut, and the chunk says so.
 */
export function reviewChunks(
  files: readonly ReviewFile[],
  budgetChars: number,
): ReviewChunk[] {
  const chunks: ReviewChunk[] = [];
  let current: ReviewChunk = { paths: [], text: "", cut: [] };
  const flush = () => {
    if (current.text) chunks.push(current);
    current = { paths: [], text: "", cut: [] };
  };
  const add = (path: string, piece: string, cut: boolean) => {
    if (current.text && current.text.length + piece.length > budgetChars) flush();
    if (!current.paths.includes(path)) current.paths.push(path);
    if (cut && !current.cut.includes(path)) current.cut.push(path);
    current.text += piece.endsWith("\n") ? piece : `${piece}\n`;
  };
  for (const file of files) {
    if (file.patch.length <= budgetChars) {
      add(file.path, file.patch, false);
      continue;
    }
    // Split at hunks, repeating the file header on each piece.
    const firstHunk = file.patch.search(/^@@ /m);
    const header = firstHunk >= 0 ? file.patch.slice(0, firstHunk) : file.patch;
    const hunks =
      firstHunk >= 0 ? file.patch.slice(firstHunk).split(/^(?=@@ )/m) : [];
    let piece = header;
    for (const hunk of hunks) {
      if (piece.length + hunk.length > budgetChars && piece !== header) {
        add(file.path, piece, false);
        flush();
        piece = header;
      }
      if (header.length + hunk.length > budgetChars) {
        const room = Math.max(0, budgetChars - header.length - 40);
        add(file.path, `${header}${hunk.slice(0, room)}\n[cut to fit]\n`, true);
        flush();
        piece = header;
        continue;
      }
      piece += hunk;
    }
    if (piece !== header) add(file.path, piece, false);
  }
  flush();
  return chunks;
}
