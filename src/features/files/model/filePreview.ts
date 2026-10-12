import { basename } from "../../../platform/tauri/fs";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".bmp",
  ".ico",
]);

const VIDEO_MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".3gp": "video/3gpp",
  ".3g2": "video/3gpp2",
};

function extensionOf(path: string): string {
  const name = basename(path).toLowerCase();
  return name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
}

/**
 * Whether a path belongs to the image viewer, decided before anything is read.
 *
 * `.svg` is deliberately absent: it is text, so it keeps opening in the editor,
 * which offers its own rendered preview alongside the source.
 */
export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(path));
}

/** Route video containers to the player, which checks codec support on load. */
export function isVideoPath(path: string): boolean {
  return videoMimeForPath(path) !== null;
}

/**
 * Only return explicit video MIME types, so even mislabeled markup cannot
 * become a document through its blob URL. The media decoder validates bytes.
 */
export function videoMimeForPath(path: string): string | null {
  return VIDEO_MIME_TYPES[extensionOf(path)] ?? null;
}

/**
 * Identify image bytes by their magic number rather than trusting the name.
 *
 * The viewer builds a blob URL, and a blob's MIME decides how the webview
 * treats it. Sniffing means an HTML file named `logo.png` fails to match and
 * lands on the unsupported card instead of becoming a same-origin document.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp";
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  // RIFF....WEBP — the four size bytes at offset 4 are skipped.
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }
  // ....ftyp{avif,avis} — an ISO base media box, shared with HEIF and MP4.
  if (startsWith(bytes.subarray(4), [0x66, 0x74, 0x79, 0x70])) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return null;
}

/** HTML files get a sandboxed preview beside their source (#35). */
export function isHtmlPath(path: string): boolean {
  const extension = extensionOf(path);
  return extension === ".html" || extension === ".htm";
}

/** PDFs open in the PDF view rather than the text editor (#35). */
export function isPdfPath(path: string): boolean {
  return extensionOf(path) === ".pdf";
}

/**
 * Whether bytes are a PDF. The blob's MIME decides how the webview treats it,
 * so an HTML file named `report.pdf` must fail here and never reach a frame.
 * The header may follow up to 1024 bytes of junk, as readers allow.
 */
export function isPdfBytes(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length - 5, 1024);
  for (let index = 0; index <= limit; index += 1) {
    if (
      bytes[index] === 0x25 &&
      bytes[index + 1] === 0x50 &&
      bytes[index + 2] === 0x44 &&
      bytes[index + 3] === 0x46 &&
      bytes[index + 4] === 0x2d
    ) {
      // Nothing that looks like markup may come before the header.
      return !bytes.subarray(0, index).includes(0x3c);
    }
  }
  return false;
}

/** Byte count for the viewer footer, in the units a file manager would show. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((byte, index) => bytes[index] === byte);
}
