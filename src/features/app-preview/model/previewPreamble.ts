import type { PreamblePart } from "../../session-preamble/model/preamble";
import { isPreviewLive, previewForSession, type AppPreview } from "./previewStore";

/**
 * #37 through F2: one status line per running preview server, so any model,
 * tools or not, knows the server exists and does not start a second one. The
 * line names the address and the command, never the environment.
 */
/** The command comes from a file the project wrote, so it is quoted as
 * data and capped: it goes into every turn, and the 16k context is small. */
const MAX_COMMAND = 160;

function quotedCommand(command: string): string {
  const flat = command.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/`/g, "'");
  const short = flat.length > MAX_COMMAND ? `${flat.slice(0, MAX_COMMAND - 1)}…` : flat;
  return `\`${short}\``;
}

export function previewStatusLine(preview: AppPreview): string {
  const where = preview.url ?? "an address it has not printed yet";
  return `MonoCode is running this project's preview server at ${where}, command ${quotedCommand(preview.command)}. It reloads as you edit files. Do not start another dev server.`;
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
