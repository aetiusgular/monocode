import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), message: vi.fn() }));
import { exportConversation, exportConversationFromMenu } from "./exportConversation";

// Local noon: the file name carries the local date (Mac finding 3.11).
const NOW = new Date(2026, 9, 12, 12, 0, 0);
const stored = {
  title: "Demo",
  harness: "claude" as const,
  model: "sonnet",
  cwd: "/p",
  blocks: [{ id: "u", role: "user" as const, text: "hi" }],
};

it("flushes, reads the saved copy, and writes where you choose", async () => {
  const order: string[] = [];
  const write = vi.fn(async () => undefined);
  const result = await exportConversation("s1", {
    flush: async () => void order.push("flush"),
    load: async (id) => (order.push(`load ${id}`), stored),
    pickPath: async (name) => (order.push(`pick ${name}`), "/Users/ada/Desktop/Demo.md"),
    write,
    now: () => NOW,
  });
  expect(order).toEqual(["flush", "load s1", "pick Demo 2026-10-12.md"]);
  expect(write).toHaveBeenCalledWith("/Users/ada/Desktop/Demo.md", expect.stringContaining("# Demo"));
  expect(result).toEqual({ status: "saved", path: "/Users/ada/Desktop/Demo.md" });
});

it("writes nothing when you cancel", async () => {
  const write = vi.fn();
  const result = await exportConversation("s1", {
    flush: async () => undefined,
    load: async () => stored,
    pickPath: async () => null,
    write,
  });
  expect(result).toEqual({ status: "cancelled" });
  expect(write).not.toHaveBeenCalled();
});

it("reports an unsaved conversation and a failed write, and says so from the menu", async () => {
  const notify = vi.fn(async () => undefined);
  expect(
    await exportConversationFromMenu("s1", {
      flush: async () => undefined,
      load: async () => null,
      notify,
    }),
  ).toEqual({ status: "error", message: "This conversation is not saved yet." });
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("not saved yet"));
  expect(
    await exportConversation("s1", {
      flush: async () => undefined,
      load: async () => stored,
      pickPath: async () => "/read-only/x.md",
      write: async () => {
        throw new Error("Permission denied");
      },
    }),
  ).toEqual({ status: "error", message: "Permission denied" });
});
