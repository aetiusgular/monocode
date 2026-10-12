import type { Session } from "../../sessions/model/session";
import { errorLines } from "../../verify/model/verify";
import { stripAnsi } from "./previewUrl";
import {
  previewForSession,
  previewOutput,
  previewSummary,
  restartPreview,
} from "./previewStore";

/**
 * #37: the preview actions an operator thread gets, through F7.
 *
 * - `preview.status`: the chat's preview, its address and state.
 * - `preview.logs`: the newest lines of its output, or only error lines.
 * - `preview.restart`: stop and start the command the user confirmed. It never
 *   starts a different command, and never one in a chat that has no preview.
 *
 * Each acts on the calling chat's own preview only.
 */

export const PREVIEW_ACTIONS = ["preview.status", "preview.logs", "preview.restart"] as const;

export const DEFAULT_LOG_LINES = 40;
export const MAX_LOG_LINES = 200;
/** The most a log reply carries, for a small context window. */
export const MAX_LOG_CHARS = 6_000;

function lineCount(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LOG_LINES;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw new Error("lines must be a whole number of 1 or more");
  return Math.min(value, MAX_LOG_LINES);
}

/** The newest `count` lines, cut from the front to `MAX_LOG_CHARS`. */
export function tailLines(output: string, count: number): string[] {
  const lines = stripAnsi(output)
    .split(/\r?\n|\r/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const picked = lines.slice(-count);
  let total = 0;
  const kept: string[] = [];
  for (let index = picked.length - 1; index >= 0; index -= 1) {
    total += picked[index].length + 1;
    if (total > MAX_LOG_CHARS) break;
    kept.unshift(picked[index]);
  }
  return kept;
}

export async function handlePreviewAction(
  source: Pick<Session, "id">,
  action: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const preview = previewForSession(source.id);
  switch (action) {
    case "preview.status":
      return preview
        ? { running: true, ...previewSummary(preview) }
        : {
            running: false,
            note: "No preview in this chat. The user starts one from the session panel.",
          };
    case "preview.logs": {
      if (!preview) throw new Error("No preview has been started in this chat");
      const count = lineCount(input.lines);
      const output = previewOutput(source.id);
      if (input.errorsOnly === true) return { lines: errorLines(output).slice(-count) };
      if (input.errorsOnly !== undefined && typeof input.errorsOnly !== "boolean")
        throw new Error("errorsOnly must be true or false");
      return { lines: tailLines(output, count) };
    }
    case "preview.restart": {
      const next = await restartPreview(source.id);
      return previewSummary(next);
    }
    default:
      throw new Error(`Unknown app action: ${action}`);
  }
}
