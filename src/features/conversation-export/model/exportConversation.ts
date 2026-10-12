import { message, save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "../../../platform/tauri/fs";
import {
  flushSessionWrites,
  getSession,
} from "../../sessions/data/sessionStore";
import {
  conversationToMarkdown,
  exportFileName,
  type ExportableSession,
} from "./exportMarkdown";

export type ExportResult =
  | { status: "saved"; path: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };

type Deps = {
  flush?: () => Promise<void>;
  load?: (sessionId: string) => Promise<ExportableSession | null>;
  pickPath?: (defaultName: string) => Promise<string | null>;
  write?: (path: string, content: string) => Promise<void>;
  now?: () => Date;
};

/**
 * Export a conversation as Markdown (#29). It reads the saved copy, after
 * pending writes are flushed, so a turn still streaming may be cut short.
 * You choose where the file goes in the save dialog; nothing leaves the Mac.
 */
export async function exportConversation(
  sessionId: string,
  deps: Deps = {},
): Promise<ExportResult> {
  const flush = deps.flush ?? flushSessionWrites;
  const load = deps.load ?? getSession;
  const pickPath = deps.pickPath ?? pickExportPath;
  const write = deps.write ?? writeTextFile;
  const now = (deps.now ?? (() => new Date()))();
  try {
    await flush();
    const session = await load(sessionId);
    if (!session) {
      return { status: "error", message: "This conversation is not saved yet." };
    }
    const path = await pickPath(exportFileName(session.title, now));
    if (!path) return { status: "cancelled" };
    await write(path, conversationToMarkdown(session, { now }));
    return { status: "saved", path };
  } catch (cause) {
    return {
      status: "error",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

async function pickExportPath(defaultName: string): Promise<string | null> {
  const chosen = await save({
    title: "Export conversation",
    defaultPath: defaultName,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  return typeof chosen === "string" && chosen ? chosen : null;
}

/** For a menu: export, and say so in a dialog only when it fails. */
export async function exportConversationFromMenu(
  sessionId: string,
  deps: Deps & { notify?: (text: string) => Promise<unknown> } = {},
): Promise<ExportResult> {
  const result = await exportConversation(sessionId, deps);
  if (result.status === "error") {
    const notify =
      deps.notify ??
      ((text: string) =>
        message(text, { title: "Export failed", kind: "error" }));
    await notify(`Couldn’t export this conversation: ${result.message}`).catch(
      () => undefined,
    );
  }
  return result;
}
