import type { PreamblePart } from "../../session-preamble/model/preamble";
import { isPreviewLive, previewForSession, type AppPreview } from "./previewStore";

/**
 * #37 through F2: one status line per running preview server, so any model,
 * tools or not, knows the server exists and does not start a second one. The
 * line names the address and the command, never the environment.
 */
export function previewStatusLine(preview: AppPreview): string {
  const where = preview.url ?? "an address it has not printed yet";
  return `MonoCode is running this project's preview server at ${where} (${preview.command}). It reloads as you edit files. Do not start another dev server.`;
}

export function previewPreamblePart(sessionId: string): PreamblePart | undefined {
  const preview = previewForSession(sessionId);
  if (!isPreviewLive(preview) || !preview) return undefined;
  return {
    id: "previews",
    label: "Preview server",
    text: previewStatusLine(preview),
  };
}
