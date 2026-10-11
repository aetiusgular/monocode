import { readBinaryFile } from "../../../platform/tauri/fs";
import { sniffImageMime } from "../../files/model/filePreview";
import { thumbnailDataUrl } from "./imageCodec";

/**
 * Reads tool-result images back off disk for the transcript.
 *
 * A thumbnail is a small PNG drawn once per file and kept as a data URL, so
 * a strip of them never holds a full screenshot in an `<img>`. A full image
 * is an object URL shared by whoever is showing it and let go soon after the
 * last of them stops.
 */

/** Thumbnails kept in memory. Each is a few KB. */
const MAX_THUMBNAILS = 300;
/**
 * Whole images kept as thumbnails where one cannot be drawn. Far fewer, as
 * each holds a full screenshot.
 */
const MAX_UNDRAWN_THUMBNAILS = 24;
/** Full images kept after their last viewer left, for flipping back to. */
const MAX_IDLE_IMAGES = 4;
/** Files read at once. A long transcript must not ask for them all together. */
const MAX_READS = 3;

type Thumbnail = { url: string; objectUrl: boolean };

const thumbnails = new Map<string, Thumbnail>();
const thumbnailLoads = new Map<string, Promise<string>>();

type FullImage = { load: Promise<string>; url?: string; viewers: number };

const fullImages = new Map<string, FullImage>();
/** Paths nobody is showing, least recently shown first. */
const idleImages: string[] = [];

/** Files a read found missing or unreadable, so they are not asked for again. */
const unreadable = new Set<string>();

const reads = new Map<string, Promise<Blob>>();
let reading = 0;
const waiting: (() => void)[] = [];

async function withReadSlot<T>(task: () => Promise<T>): Promise<T> {
  if (reading >= MAX_READS) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  reading++;
  try {
    return await task();
  } finally {
    reading--;
    waiting.shift()?.();
  }
}

/** The file as an image blob. Two callers asking at once share one read. */
function readImage(path: string): Promise<Blob> {
  if (unreadable.has(path)) {
    return Promise.reject(new Error("Image is not on disk."));
  }
  const pending = reads.get(path);
  if (pending) return pending;
  const read = withReadSlot(async () => {
    const bytes = await readBinaryFile(path);
    const mime = sniffImageMime(bytes);
    if (!mime) throw new Error("Not an image.");
    return new Blob([bytes], { type: mime });
  });
  reads.set(path, read);
  void read.catch(() => unreadable.add(path)).finally(() => reads.delete(path));
  return read;
}

function canMakeObjectUrl(): boolean {
  return (
    typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
  );
}

/** The thumbnail already drawn for a file, if there is one. */
export function cachedToolImageThumbnail(path: string): string | undefined {
  return thumbnails.get(path)?.url;
}

/** A small image for a thumbnail strip. Rejects when the file is gone. */
export function loadToolImageThumbnail(path: string): Promise<string> {
  const cached = thumbnails.get(path);
  if (cached) return Promise.resolve(cached.url);
  const pending = thumbnailLoads.get(path);
  if (pending) return pending;
  const load = readImage(path).then(async (blob) => {
    const drawn = await thumbnailDataUrl(blob);
    // Without a canvas the whole image stands in, which only tests reach.
    if (!drawn && !canMakeObjectUrl()) throw new Error("Cannot show image.");
    const thumbnail: Thumbnail = drawn
      ? { url: drawn, objectUrl: false }
      : { url: URL.createObjectURL(blob), objectUrl: true };
    thumbnails.set(path, thumbnail);
    while (thumbnails.size > MAX_THUMBNAILS) {
      const oldest = thumbnails.keys().next().value;
      if (oldest === undefined) break;
      dropThumbnail(oldest);
    }
    if (thumbnail.objectUrl) {
      const undrawn = [...thumbnails].filter(([, entry]) => entry.objectUrl);
      for (const [stale] of undrawn.slice(
        0,
        Math.max(0, undrawn.length - MAX_UNDRAWN_THUMBNAILS),
      )) {
        dropThumbnail(stale);
      }
    }
    return thumbnail.url;
  });
  thumbnailLoads.set(path, load);
  void load.catch(() => undefined).finally(() => thumbnailLoads.delete(path));
  return load;
}

function dropThumbnail(path: string): void {
  const thumbnail = thumbnails.get(path);
  if (!thumbnail) return;
  thumbnails.delete(path);
  if (thumbnail.objectUrl) URL.revokeObjectURL(thumbnail.url);
}

/**
 * The full image as an object URL. Every call must be paired with
 * `releaseToolImage` once the caller stops showing it.
 */
export function acquireToolImage(path: string): Promise<string> {
  const known = fullImages.get(path);
  if (known) {
    known.viewers++;
    const idle = idleImages.indexOf(path);
    if (idle >= 0) idleImages.splice(idle, 1);
    return known.load;
  }
  const entry: FullImage = {
    viewers: 1,
    load: readImage(path).then((blob) => {
      if (!canMakeObjectUrl()) throw new Error("Cannot show image.");
      entry.url = URL.createObjectURL(blob);
      // Let go while it was still being read.
      if (fullImages.get(path) !== entry) URL.revokeObjectURL(entry.url);
      return entry.url;
    }),
  };
  fullImages.set(path, entry);
  void entry.load.catch(() => {
    if (fullImages.get(path) === entry) dropFullImage(path);
  });
  return entry.load;
}

export function releaseToolImage(path: string): void {
  const entry = fullImages.get(path);
  if (!entry) return;
  entry.viewers = Math.max(0, entry.viewers - 1);
  if (entry.viewers > 0) return;
  idleImages.push(path);
  while (idleImages.length > MAX_IDLE_IMAGES) {
    const oldest = idleImages.shift();
    if (oldest !== undefined) dropFullImage(oldest);
  }
}

function dropFullImage(path: string): void {
  const entry = fullImages.get(path);
  fullImages.delete(path);
  const idle = idleImages.indexOf(path);
  if (idle >= 0) idleImages.splice(idle, 1);
  if (entry?.url) URL.revokeObjectURL(entry.url);
}

/** Test-only: drop every cached image. */
export function __toolImageFilesTestReset(): void {
  for (const path of [...thumbnails.keys()]) dropThumbnail(path);
  for (const path of [...fullImages.keys()]) dropFullImage(path);
  thumbnailLoads.clear();
  reads.clear();
  unreadable.clear();
  waiting.length = 0;
  reading = 0;
}
