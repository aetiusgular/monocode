import { ask } from "@tauri-apps/plugin-dialog";

/** The question before one chat is deleted (Mac test 11.T2.6). */
export const DELETE_CHAT_QUESTION = "Delete this chat? This cannot be undone.";

export function deleteChatsQuestion(count: number): string {
  return count === 1
    ? DELETE_CHAT_QUESTION
    : `Delete ${count} chats? This cannot be undone.`;
}

/**
 * Ask before deleting chats, in the native sheet: `window.confirm` is
 * swallowed when a macOS menu accelerator fires. A failed dialog reads as No.
 */
export async function confirmDeleteChats(count: number): Promise<boolean> {
  if (count <= 0) return false;
  try {
    return await ask(deleteChatsQuestion(count), {
      title: "MonoCode",
      kind: "warning",
    });
  } catch {
    return false;
  }
}
