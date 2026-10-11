import { describe, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => ({
  saveGeneratedImage: vi.fn(async () => ({
    path: "/data/generated-images/1.png",
    mimeType: "image/png",
    size: 1,
  })),
}));
vi.mock("../../platform/tauri/fs", async (original) => ({
  ...(await original<typeof import("../../platform/tauri/fs")>()),
  saveGeneratedImage: fs.saveGeneratedImage,
}));
vi.mock("../monos/model/mono", () => ({
  isMonoSession: (sessionId: string) => sessionId === "mono_session",
}));

// Loading the feature is what tells the store which sessions to leave alone.
await import("./index");
const { keepToolResultImages } = await import("./data/toolImageStore");

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("the tool-images feature", () => {
  it("keeps images for a regular session and none for a Mono", async () => {
    const emit = vi.fn();
    await keepToolResultImages({
      sessionId: "mono_session",
      callId: "toolu_1",
      images: [{ data: PNG, mimeType: "image/png" }],
      emit,
    });
    expect(fs.saveGeneratedImage).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();

    await keepToolResultImages({
      sessionId: "regular_session",
      callId: "toolu_1",
      images: [{ data: PNG, mimeType: "image/png" }],
      emit,
    });
    expect(fs.saveGeneratedImage).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
