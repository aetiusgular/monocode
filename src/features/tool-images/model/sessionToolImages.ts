import type { Block } from "../../sessions/model/session";
import {
  isSubagentBlock,
  subagentName,
  toolCallLabel,
} from "../../sessions/model/transcriptActivity";
import type { ToolImageRef } from "./toolImages";

/** One tool-result image with the tool call it belongs to. */
export type SessionToolImage = {
  ref: ToolImageRef;
  blockId: string;
  /** The tool call's title, as its row in the transcript shows it. */
  title: string;
};

const NO_IMAGES: readonly SessionToolImage[] = [];

/** Every tool-result image of a session, oldest first. */
export function sessionToolImages(
  blocks: readonly Block[],
  cwd?: string,
): readonly SessionToolImage[] {
  let found: SessionToolImage[] | null = null;
  for (const block of blocks) {
    if (!block.toolImages?.length) continue;
    const title = isSubagentBlock(block)
      ? subagentName(block)
      : toolCallLabel(block, cwd);
    for (const ref of block.toolImages) {
      (found ??= []).push({ ref, blockId: block.id, title });
    }
  }
  return found ?? NO_IMAGES;
}

/** Whether two image lists show the same thing, so a render can be skipped. */
export function sameSessionToolImages(
  a: readonly SessionToolImage[],
  b: readonly SessionToolImage[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every(
    (entry, index) =>
      entry.ref === b[index].ref &&
      entry.blockId === b[index].blockId &&
      entry.title === b[index].title,
  );
}

/** The image a live preview shows: the one that arrived last. */
export function latestToolImage(
  images: readonly SessionToolImage[],
): SessionToolImage | null {
  return images.length > 0 ? images[images.length - 1] : null;
}
