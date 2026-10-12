import type { ToolResultImage } from "../../tool-images/model/toolImages";

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * The images in a finished Codex MCP tool call, such as a browser screenshot,
 * for the transcript. Codex sends MCP content blocks as they came from the
 * server (`McpToolCallResult.content`, `rust-v0.161.0`), so an image is
 * `{ type: "image", data, mimeType }`. Only the parent thread's items, and
 * only the four common image types; the image store caps size and count.
 */
export function codexMcpResultImages(
  method: string,
  params: unknown,
  threadId: string,
): { callId: string; images: ToolResultImage[] } | null {
  if (method !== "item/completed") return null;
  if (!params || typeof params !== "object") return null;
  const rec = params as Record<string, unknown>;
  if (rec.threadId !== undefined && rec.threadId !== threadId) return null;
  const item = rec.item as Record<string, unknown> | undefined;
  if (!item || item.type !== "mcpToolCall" || typeof item.id !== "string")
    return null;
  const result = item.result as Record<string, unknown> | null | undefined;
  const content = Array.isArray(result?.content) ? result.content : [];
  const images = content.flatMap((block): ToolResultImage[] => {
    if (!block || typeof block !== "object") return [];
    const b = block as Record<string, unknown>;
    return b.type === "image" &&
      typeof b.data === "string" &&
      b.data.length > 0 &&
      typeof b.mimeType === "string" &&
      IMAGE_TYPES.has(b.mimeType)
      ? [{ data: b.data, mimeType: b.mimeType }]
      : [];
  });
  return images.length ? { callId: item.id, images } : null;
}
