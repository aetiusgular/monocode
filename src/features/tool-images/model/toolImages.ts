import type { Block } from "../../sessions/model/session";

/**
 * An image as a tool result carries it: base64, straight off the harness.
 * It only travels from an adapter to the image store. It never reaches the
 * transcript and is never saved with a session.
 */
export type ToolResultImage = {
  data: string;
  mimeType: string;
};

/**
 * A tool-result image kept for the transcript: a PNG in the app's
 * generated-image folder. A block carries these instead of the bytes, so a
 * saved session grows by a path per screenshot, not by the screenshot.
 */
export type ToolImageRef = {
  /** Unique in the session: the call it came from and its place in the result. */
  id: string;
  path: string;
  mimeType: string;
  /** Bytes on disk. */
  size: number;
};

/** Images kept from one tool result. A result with more keeps its first ones. */
export const MAX_TOOL_IMAGES_PER_RESULT = 6;

/**
 * Images kept on disk for one session while the app runs. When a session
 * goes past it the oldest are deleted, so a long browser run keeps its most
 * recent screenshots.
 */
export const MAX_TOOL_IMAGES_PER_SESSION = 100;

/** Largest image kept, as base64 characters (about 12 MB of image). */
export const MAX_TOOL_IMAGE_DATA_CHARS = 16 * 1024 * 1024;

/** Thumbnails a tool row shows before the rest fold into a "+N" chip. */
export const MAX_STRIP_THUMBNAILS = 4;

/** Files a session's tool-result images live in, for deleting with it. */
export function toolImagePaths(blocks: readonly Block[]): string[] {
  return blocks.flatMap(
    (block) => block.toolImages?.map((image) => image.path) ?? [],
  );
}

/**
 * Every image file a session owns: the ones the agent generated and the ones
 * its tool calls returned. Deleting the session deletes these.
 */
export function sessionImagePaths(blocks: readonly Block[]): string[] {
  return blocks.flatMap((block) => [
    ...(block.role === "image" && block.image ? [block.image.path] : []),
    ...(block.toolImages?.map((image) => image.path) ?? []),
  ]);
}

/**
 * Puts saved images on the tool call they came from, and takes off any the
 * store has deleted to stay under the session's limit. Returns the same
 * array when nothing changes.
 */
export function attachToolImages(
  blocks: Block[],
  callId: string,
  images: readonly ToolImageRef[],
  dropped: readonly string[] = [],
): Block[] {
  const gone = dropped.length > 0 ? new Set(dropped) : null;
  const target = images.length
    ? blocks.findIndex((block) => block.tool?.callId === callId)
    : -1;
  let next: Block[] | null = null;
  blocks.forEach((block, index) => {
    const current = block.toolImages ?? [];
    let kept = gone
      ? current.filter((image) => !gone.has(image.path))
      : current;
    if (index === target) {
      const known = new Set(kept.map((image) => image.id));
      const added = images.filter(
        (image) => !known.has(image.id) && !gone?.has(image.path),
      );
      if (added.length > 0) kept = [...kept, ...added];
    }
    if (kept.length === current.length) return;
    next ??= blocks.slice();
    if (kept.length > 0) {
      next[index] = { ...block, toolImages: kept };
    } else {
      const { toolImages: _removed, ...rest } = block;
      next[index] = rest;
    }
  });
  return next ?? blocks;
}

/** Reads saved image references back, dropping anything malformed. */
export function sanitizeToolImages(value: unknown): ToolImageRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const images = value.flatMap((entry): ToolImageRef[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const path = typeof record.path === "string" ? record.path.trim() : "";
    const mimeType =
      typeof record.mimeType === "string" ? record.mimeType.trim() : "";
    const size = record.size;
    if (
      !id ||
      id.length > 256 ||
      seen.has(id) ||
      !path ||
      !mimeType.startsWith("image/") ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size <= 0
    ) {
      return [];
    }
    seen.add(id);
    return [{ id, path, mimeType, size }];
  });
  if (images.length === 0) return undefined;
  return images.slice(-MAX_TOOL_IMAGES_PER_SESSION);
}
