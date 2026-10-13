import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../../integrations/harness/core/types";
import {
  MAX_TOOL_IMAGE_DATA_CHARS,
  MAX_TOOL_IMAGES_PER_RESULT,
  MAX_TOOL_IMAGES_PER_SESSION,
} from "../model/toolImages";

const fs = vi.hoisted(() => ({
  saveGeneratedImage: vi.fn(),
  deleteGeneratedImages: vi.fn(async (_paths: string[]) => undefined),
  readBinaryFile: vi.fn(),
}));
vi.mock("../../../platform/tauri/fs", () => fs);

const { keepToolResultImages, skipToolImagesFor, __toolImageStoreTestReset } =
  await import("./toolImageStore");

/** A real one-pixel PNG. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
/** The first bytes of a JPEG. */
const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2w==";

type ImagesEvent = Extract<HarnessEvent, { type: "tool.images" }>;

let saved = 0;

beforeEach(() => {
  saved = 0;
  __toolImageStoreTestReset();
  fs.deleteGeneratedImages.mockClear();
  fs.saveGeneratedImage.mockReset();
  fs.saveGeneratedImage.mockImplementation(
    async (input: { data: string; name: string }) => ({
      path: `/data/generated-images/${++saved}-${input.name}.png`,
      mimeType: "image/png",
      size: input.data.length,
    }),
  );
});

function png(count = 1) {
  return Array.from({ length: count }, () => ({
    data: PNG,
    mimeType: "image/png",
  }));
}

describe("keepToolResultImages", () => {
  it("saves a result's images and reports where they are", async () => {
    const events: ImagesEvent[] = [];
    await keepToolResultImages({
      sessionId: "s1",
      callId: "toolu_1",
      images: png(2),
      emit: (event) => events.push(event),
    });
    expect(fs.saveGeneratedImage).toHaveBeenCalledTimes(2);
    expect(fs.saveGeneratedImage).toHaveBeenCalledWith({
      data: PNG,
      name: "tool-image",
      sessionId: "s1",
    });
    expect(events).toEqual([
      {
        type: "tool.images",
        callId: "toolu_1",
        images: [
          {
            id: "toolu_1:0",
            path: "/data/generated-images/1-tool-image.png",
            mimeType: "image/png",
            size: PNG.length,
          },
          {
            id: "toolu_1:1",
            path: "/data/generated-images/2-tool-image.png",
            mimeType: "image/png",
            size: PNG.length,
          },
        ],
      },
    ]);
    // No base64 leaves the store.
    expect(JSON.stringify(events)).not.toContain(PNG);
  });

  it("names a subagent's images after the subagent's own call", async () => {
    const events: ImagesEvent[] = [];
    await keepToolResultImages({
      sessionId: "s1",
      callId: "toolu_agent",
      sourceId: "toolu_inner",
      images: png(),
      emit: (event) => events.push(event),
    });
    expect(events[0].callId).toBe("toolu_agent");
    expect(events[0].images[0].id).toBe("toolu_inner:0");
  });

  it("does nothing for a result without images", async () => {
    const emit = vi.fn();
    await keepToolResultImages({
      sessionId: "s1",
      callId: "toolu_1",
      images: [],
      emit,
    });
    expect(fs.saveGeneratedImage).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("keeps the first few images of a result that has many", async () => {
    const events: ImagesEvent[] = [];
    await keepToolResultImages({
      sessionId: "s1",
      callId: "toolu_1",
      images: png(MAX_TOOL_IMAGES_PER_RESULT + 3),
      emit: (event) => events.push(event),
    });
    expect(events[0].images).toHaveLength(MAX_TOOL_IMAGES_PER_RESULT);
  });

  it("leaves out an image that is too large or cannot be saved", async () => {
    const events: ImagesEvent[] = [];
    fs.saveGeneratedImage.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });
    await keepToolResultImages({
      sessionId: "s1",
      callId: "toolu_1",
      images: [
        ...png(),
        {
          data: PNG + "A".repeat(MAX_TOOL_IMAGE_DATA_CHARS),
          mimeType: "image/png",
        },
        ...png(),
      ],
      emit: (event) => events.push(event),
    });
    // The first save failed, the second image was never tried.
    expect(fs.saveGeneratedImage).toHaveBeenCalledTimes(2);
    expect(events[0].images.map((image) => image.id)).toEqual(["toolu_1:2"]);
  });

  it("skips an image that is not a PNG where it cannot be redrawn", async () => {
    // No canvas here. In the app a JPEG is drawn again as PNG and kept.
    const emit = vi.fn();
    await keepToolResultImages({
      sessionId: "s1",
      callId: "toolu_1",
      images: [{ data: JPEG, mimeType: "image/jpeg" }],
      emit,
    });
    expect(fs.saveGeneratedImage).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("deletes what it saved for a session that has stopped", async () => {
    const emit = vi.fn();
    await keepToolResultImages({
      sessionId: "s1",
      callId: "toolu_1",
      images: png(),
      emit,
      wanted: () => false,
    });
    expect(emit).not.toHaveBeenCalled();
    expect(fs.deleteGeneratedImages).toHaveBeenCalledWith([
      "/data/generated-images/1-tool-image.png",
    ]);
  });

  it("deletes a session's oldest files once it is over its limit", async () => {
    const events: ImagesEvent[] = [];
    for (let call = 0; call < MAX_TOOL_IMAGES_PER_SESSION; call++) {
      await keepToolResultImages({
        sessionId: "s1",
        callId: `toolu_${call}`,
        images: png(),
        emit: (event) => events.push(event),
      });
    }
    expect(events.some((event) => event.dropped)).toBe(false);
    expect(fs.deleteGeneratedImages).not.toHaveBeenCalled();

    await keepToolResultImages({
      sessionId: "s1",
      callId: "toolu_over",
      images: png(2),
      emit: (event) => events.push(event),
    });
    const dropped = [
      "/data/generated-images/1-tool-image.png",
      "/data/generated-images/2-tool-image.png",
    ];
    expect(events[events.length - 1].dropped).toEqual(dropped);
    expect(fs.deleteGeneratedImages).toHaveBeenCalledWith(dropped);

    // Another session has its own count.
    await keepToolResultImages({
      sessionId: "s2",
      callId: "toolu_other",
      images: png(),
      emit: (event) => events.push(event),
    });
    expect(events[events.length - 1].dropped).toBeUndefined();
  });

  it("reports results in the order they came, however long a save takes", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    fs.saveGeneratedImage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ path: "/slow.png", mimeType: "image/png", size: 1 });
        }),
    );
    const first = keepToolResultImages({
      sessionId: "s1",
      callId: "toolu_slow",
      images: png(),
      emit: (event) => order.push(event.callId),
    });
    const second = keepToolResultImages({
      sessionId: "s1",
      callId: "toolu_fast",
      images: png(),
      emit: (event) => order.push(event.callId),
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    release!();
    await Promise.all([first, second]);
    expect(order).toEqual(["toolu_slow", "toolu_fast"]);
  });

  it("keeps nothing for a session the app has ruled out", async () => {
    skipToolImagesFor((sessionId) => sessionId === "mono_session");
    const emit = vi.fn();
    await keepToolResultImages({
      sessionId: "mono_session",
      callId: "toolu_1",
      images: png(),
      emit,
    });
    expect(fs.saveGeneratedImage).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();

    await keepToolResultImages({
      sessionId: "s1",
      callId: "toolu_1",
      images: png(),
      emit,
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
