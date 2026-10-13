import { beforeEach, describe, expect, it, vi } from "vitest";

// Mac test 11.T2.6: the sidebar's Delete removed a chat at once.

const ask = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask }));

import {
  DELETE_CHAT_QUESTION,
  confirmDeleteChats,
  deleteChatsQuestion,
} from "./deleteConfirm";

beforeEach(() => {
  ask.mockReset();
});

describe("confirmDeleteChats", () => {
  it("asks in the native sheet before one chat is deleted", async () => {
    ask.mockResolvedValueOnce(true);
    await expect(confirmDeleteChats(1)).resolves.toBe(true);
    expect(ask).toHaveBeenCalledWith(
      "Delete this chat? This cannot be undone.",
      { title: "MonoCode", kind: "warning" },
    );
    expect(DELETE_CHAT_QUESTION).toBe(
      "Delete this chat? This cannot be undone.",
    );
  });

  it("keeps the chat when the user says No", async () => {
    ask.mockResolvedValueOnce(false);
    await expect(confirmDeleteChats(1)).resolves.toBe(false);
  });

  it("reads a dialog that fails as No", async () => {
    ask.mockRejectedValueOnce(new Error("dialog unavailable"));
    await expect(confirmDeleteChats(1)).resolves.toBe(false);
  });

  it("names the count for a bulk delete and asks nothing for none", async () => {
    expect(deleteChatsQuestion(3)).toBe(
      "Delete 3 chats? This cannot be undone.",
    );
    await expect(confirmDeleteChats(0)).resolves.toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });
});
