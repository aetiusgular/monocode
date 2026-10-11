import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => ({ readBinaryFile: vi.fn() }));
vi.mock("../../../platform/tauri/fs", () => fs);

const {
  acquireToolImage,
  cachedToolImageThumbnail,
  loadToolImageThumbnail,
  releaseToolImage,
  __toolImageFilesTestReset,
} = await import("./toolImageFiles");

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

let made: string[] = [];
let revoked: string[] = [];

beforeEach(() => {
  __toolImageFilesTestReset();
  made = [];
  revoked = [];
  fs.readBinaryFile.mockReset();
  fs.readBinaryFile.mockImplementation(async () => PNG_BYTES);
  vi.stubGlobal(
    "URL",
    Object.assign(globalThis.URL, {
      createObjectURL: () => {
        const url = `blob:image-${made.length + 1}`;
        made.push(url);
        return url;
      },
      revokeObjectURL: (url: string) => {
        revoked.push(url);
      },
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("thumbnails", () => {
  it("reads a file once however many rows ask for it", async () => {
    const [first, second] = await Promise.all([
      loadToolImageThumbnail("/a.png"),
      loadToolImageThumbnail("/a.png"),
    ]);
    expect(first).toBe(second);
    expect(fs.readBinaryFile).toHaveBeenCalledTimes(1);
    expect(cachedToolImageThumbnail("/a.png")).toBe(first);
    await loadToolImageThumbnail("/a.png");
    expect(fs.readBinaryFile).toHaveBeenCalledTimes(1);
  });

  it("rejects for a file that is gone and does not ask again", async () => {
    fs.readBinaryFile.mockRejectedValue(new Error("No such file"));
    await expect(loadToolImageThumbnail("/gone.png")).rejects.toThrow();
    await expect(loadToolImageThumbnail("/gone.png")).rejects.toThrow();
    expect(fs.readBinaryFile).toHaveBeenCalledTimes(1);
    expect(cachedToolImageThumbnail("/gone.png")).toBeUndefined();
  });

  it("rejects bytes that are not an image", async () => {
    fs.readBinaryFile.mockResolvedValue(new TextEncoder().encode("<html>"));
    await expect(loadToolImageThumbnail("/page.png")).rejects.toThrow();
    expect(made).toEqual([]);
  });

  it("holds only a few whole images where a thumbnail cannot be drawn", async () => {
    // No canvas here, so each thumbnail is the image itself.
    const urls: string[] = [];
    for (let index = 0; index < 30; index++) {
      urls.push(await loadToolImageThumbnail(`/undrawn-${index}.png`));
    }
    expect(revoked).toEqual(urls.slice(0, 6));
    expect(cachedToolImageThumbnail("/undrawn-0.png")).toBeUndefined();
    expect(cachedToolImageThumbnail("/undrawn-29.png")).toBe(urls[29]);
  });

  it("reads a few files at a time", async () => {
    let running = 0;
    let most = 0;
    fs.readBinaryFile.mockImplementation(async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running--;
      return PNG_BYTES;
    });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        loadToolImageThumbnail(`/many-${index}.png`),
      ),
    );
    expect(fs.readBinaryFile).toHaveBeenCalledTimes(12);
    expect(most).toBeLessThanOrEqual(3);
  });
});

describe("full images", () => {
  it("shares one object URL between everything showing the image", async () => {
    const [first, second] = await Promise.all([
      acquireToolImage("/a.png"),
      acquireToolImage("/a.png"),
    ]);
    expect(first).toBe(second);
    expect(fs.readBinaryFile).toHaveBeenCalledTimes(1);
    releaseToolImage("/a.png");
    releaseToolImage("/a.png");
    // Still there to flip back to.
    expect(revoked).toEqual([]);
    expect(await acquireToolImage("/a.png")).toBe(first);
    expect(fs.readBinaryFile).toHaveBeenCalledTimes(1);
  });

  it("lets go of images nobody has shown for a while", async () => {
    const urls: string[] = [];
    for (let index = 0; index < 6; index++) {
      urls.push(await acquireToolImage(`/image-${index}.png`));
      releaseToolImage(`/image-${index}.png`);
    }
    expect(revoked).toEqual(urls.slice(0, 2));
  });

  it("never revokes an image that is still on screen", async () => {
    const shown = await acquireToolImage("/shown.png");
    for (let index = 0; index < 8; index++) {
      await acquireToolImage(`/image-${index}.png`);
      releaseToolImage(`/image-${index}.png`);
    }
    expect(revoked).not.toContain(shown);
  });
});
