/**
 * Browser-side image work for tool-result images: re-encoding one as PNG so
 * the generated-image folder accepts it, and drawing a small thumbnail. Both
 * need a canvas, so both answer null where there is none (unit tests).
 */

/** Longest edge kept when an image has to be re-encoded, in px. */
const MAX_CONVERTED_EDGE = 2400;

/** Height thumbnails are drawn at, in px: a 40 px row at twice the density. */
const THUMBNAIL_HEIGHT = 96;
const MAX_THUMBNAIL_WIDTH = 320;

const PNG_DATA_URL = "data:image/png;base64,";
/** The eight-byte PNG signature, in base64. */
const PNG_BASE64_SIGNATURE = "iVBORw0KGgo";

export function isPngBase64(data: string): boolean {
  return data.startsWith(PNG_BASE64_SIGNATURE);
}

export function base64Bytes(data: string): Uint8Array | null {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** Decodes and draws an image, at most `maxWidth` by `maxHeight`, as a PNG. */
async function drawAsPng(
  blob: Blob,
  maxWidth: number,
  maxHeight: number,
): Promise<string | null> {
  if (
    typeof createImageBitmap !== "function" ||
    typeof document === "undefined"
  ) {
    return null;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    if (bitmap.width <= 0 || bitmap.height <= 0) return null;
    const scale = Math.min(
      1,
      maxWidth / bitmap.width,
      maxHeight / bitmap.height,
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/png");
    return url.startsWith(PNG_DATA_URL) ? url : null;
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}

/**
 * The image as PNG base64. A PNG passes through untouched. Anything else
 * (JPEG, WebP, GIF) is decoded and drawn again, which needs a canvas.
 */
export async function pngBase64(
  data: string,
  mimeType: string,
): Promise<string | null> {
  const trimmed = data.trim();
  if (isPngBase64(trimmed)) return trimmed;
  const bytes = base64Bytes(trimmed);
  if (!bytes) return null;
  const url = await drawAsPng(
    new Blob([bytes], { type: mimeType }),
    MAX_CONVERTED_EDGE,
    MAX_CONVERTED_EDGE,
  );
  return url ? url.slice(PNG_DATA_URL.length) : null;
}

/** A small PNG data URL of the image, or null where it cannot be drawn. */
export function thumbnailDataUrl(blob: Blob): Promise<string | null> {
  return drawAsPng(blob, MAX_THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
}
