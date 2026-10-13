import { copyPath, pickFolders } from "../../../platform/tauri/fs";

export type SaveCopyResult =
  | { status: "saved"; path: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };

/**
 * Save on a file card: you pick a folder, and the document is copied into it.
 *
 * The copy goes through `copy_path`, which picks a free name the way Finder
 * does (`report copy.pdf`, then `report copy 2.pdf`)
 * rather than overwrite anything already there, and leaves the agent's file
 * where it is. Nothing runs and nothing is sent anywhere.
 */
export async function saveCopyOf(
  path: string,
  deps: {
    pick?: (title: string) => Promise<string[]>;
    copy?: (from: string, destParent: string) => Promise<string>;
  } = {},
): Promise<SaveCopyResult> {
  const pick = deps.pick ?? pickFolders;
  const copy = deps.copy ?? copyPath;
  let folders: string[];
  try {
    folders = await pick("Save a copy to");
  } catch (cause) {
    return { status: "error", message: messageOf(cause) };
  }
  // The picker allows several folders; a copy goes to the first only.
  const destination = folders[0];
  if (!destination) return { status: "cancelled" };
  try {
    return { status: "saved", path: await copy(path, destination) };
  } catch (cause) {
    return { status: "error", message: messageOf(cause) };
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
