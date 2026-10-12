// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, type Block } from "../../sessions/model/session";
import type { ToolImageRef } from "../model/toolImages";

const fs = vi.hoisted(() => ({ readBinaryFile: vi.fn() }));
vi.mock("../../../platform/tauri/fs", async (original) => ({
  ...(await original<typeof import("../../../platform/tauri/fs")>()),
  readBinaryFile: fs.readBinaryFile,
}));
vi.mock("../../../platform/tauri/trackpadZoom", () => ({
  claimTrackpadMagnify: () => () => {},
}));

const { __toolImageFilesTestReset } = await import("../data/toolImageFiles");
const { SessionPanelView } =
  await import("../../session-panel/ui/SessionPanel");
const { PreviewSection } = await import("./PreviewSection");
const { ToolImageGalleryHost } = await import("./ToolImageGallery");
const { openToolImageGallery } = await import("./toolImageGalleryStore");
const { ToolImageStrip } = await import("./ToolImageStrip");

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

let container: HTMLDivElement;
let root: Root;
/** Strips waiting to come near the viewport before they read their files. */
let watching: (() => void)[] = [];
/** Whether a strip is near the viewport as soon as it mounts. */
let onScreen = true;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  __toolImageFilesTestReset();
  fs.readBinaryFile.mockReset();
  fs.readBinaryFile.mockImplementation(async () => PNG_BYTES);
  // One URL per file read, named after the order the files were read in.
  let made = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    () => `blob:image-${++made}`,
  );
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  watching = [];
  onScreen = true;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(
        private readonly onChange: (
          entries: { isIntersecting: boolean }[],
        ) => void,
      ) {}
      observe() {
        const enter = () => this.onChange([{ isIntersecting: true }]);
        if (onScreen) enter();
        else watching.push(enter);
      }
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function image(id: string): ToolImageRef {
  return {
    id,
    path: `/data/generated-images/${id}.png`,
    mimeType: "image/png",
    size: 2048,
  };
}

function tool(callId: string, title: string, images: number): Block {
  return {
    id: `block_${callId}`,
    role: "tool",
    text: title,
    tool: { callId, title, kind: "other", status: "completed" },
    ...(images > 0
      ? {
          toolImages: Array.from({ length: images }, (_, index) =>
            image(`${callId}:${index}`),
          ),
        }
      : {}),
  };
}

const user: Block = { id: "user", role: "user", text: "Check the page." };
const first = tool("shot", "Take a screenshot", 1);
const many = tool("steps", "Screenshot every step", 6);
const blocks = [user, first, tool("bash", "npm test", 0), many];

/** Lets file reads settle and the frame after them run. */
async function settle() {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** A transcript's rows and the pane's gallery, as SessionPane mounts them. */
async function renderTranscript(shown: Block[] = blocks) {
  act(() =>
    root.render(
      createElement(
        Fragment,
        null,
        ...shown
          .filter((block) => block.role === "tool")
          .map((block) =>
            createElement(ToolImageStrip, {
              key: block.id,
              block,
              label: block.text,
            }),
          ),
        createElement(ToolImageGalleryHost, { blocks: shown }),
      ),
    ),
  );
  await settle();
}

function thumbnails(): HTMLButtonElement[] {
  return [
    ...container.querySelectorAll<HTMLButtonElement>("[data-tool-image]"),
  ];
}

function gallery(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

function position(): string | undefined {
  return gallery()?.querySelector("[data-gallery-position]")?.textContent;
}

function press(key: string) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

describe("ToolImageStrip", () => {
  it("shows a thumbnail per image, four at most, then a count", async () => {
    await renderTranscript();
    const strips = container.querySelectorAll("[data-tool-images]");
    // The call that returned text only has no strip.
    expect(strips).toHaveLength(2);
    expect(strips[0].querySelectorAll("[data-tool-image]")).toHaveLength(1);
    expect(strips[0].querySelector("[data-tool-images-more]")).toBeNull();
    expect(strips[1].querySelectorAll("[data-tool-image]")).toHaveLength(4);
    const more = strips[1].querySelector("[data-tool-images-more]");
    expect(more?.textContent).toBe("+2");
    expect(more?.getAttribute("aria-label")).toBe(
      "Open 2 more images from Screenshot every step",
    );
    expect(thumbnails()[0].getAttribute("aria-label")).toBe(
      "Open image 1 of 1 from Take a screenshot",
    );
    expect(thumbnails()[0].querySelector("img")?.getAttribute("src")).toMatch(
      /^blob:image-/,
    );
    // Only the files behind a thumbnail are read.
    expect(fs.readBinaryFile).toHaveBeenCalledTimes(5);
  });

  it("reads nothing until the row comes near the viewport", async () => {
    onScreen = false;
    await renderTranscript([many]);
    expect(thumbnails()).toHaveLength(4);
    expect(container.querySelectorAll("[data-tool-image] img")).toHaveLength(0);
    expect(fs.readBinaryFile).not.toHaveBeenCalled();

    act(() => watching.forEach((enter) => enter()));
    await settle();
    expect(container.querySelectorAll("[data-tool-image] img")).toHaveLength(4);
    expect(fs.readBinaryFile).toHaveBeenCalledTimes(4);
  });

  it("leaves out a thumbnail whose file is gone", async () => {
    fs.readBinaryFile.mockImplementation(async (path: string) => {
      if (path.includes("steps:1")) throw new Error("No such file");
      return PNG_BYTES;
    });
    await renderTranscript([many]);
    expect(thumbnails().map((button) => button.dataset.toolImage)).toEqual([
      "steps:0",
      "steps:2",
      "steps:3",
    ]);
  });
});

describe("ToolImageGallery", () => {
  it("opens on the thumbnail clicked and steps across the whole session", async () => {
    await renderTranscript();
    expect(gallery()).toBeNull();
    const opener = thumbnails()[1];
    act(() => opener.focus());
    act(() => opener.click());
    await settle();

    expect(gallery()).not.toBeNull();
    // The second image of the session: the first of the second call.
    expect(position()).toBe("2 of 7");
    expect(gallery()?.getAttribute("aria-label")).toBe(
      "Image preview: Screenshot every step, image 2 of 7",
    );
    expect(gallery()?.querySelector("img")?.getAttribute("src")).toMatch(
      /^blob:image-/,
    );

    press("ArrowRight");
    expect(position()).toBe("3 of 7");
    act(() =>
      gallery()!
        .querySelector<HTMLButtonElement>("[data-gallery-next]")!
        .click(),
    );
    expect(position()).toBe("4 of 7");
    act(() =>
      gallery()!
        .querySelector<HTMLButtonElement>("[data-gallery-previous]")!
        .click(),
    );
    expect(position()).toBe("3 of 7");
    press("ArrowLeft");
    press("ArrowLeft");
    expect(position()).toBe("1 of 7");
    expect(gallery()?.getAttribute("aria-label")).toBe(
      "Image preview: Take a screenshot, image 1 of 7",
    );

    // Nothing before the first image.
    const previous = gallery()!.querySelector("[data-gallery-previous]")!;
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    press("ArrowLeft");
    expect(position()).toBe("1 of 7");

    press("Escape");
    await settle();
    expect(gallery()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("opens past the thumbnails from the count chip", async () => {
    await renderTranscript();
    const more = container.querySelector<HTMLButtonElement>(
      "[data-tool-images-more]",
    )!;
    act(() => more.click());
    await settle();
    expect(position()).toBe("6 of 7");
    press("ArrowRight");
    expect(position()).toBe("7 of 7");
    expect(
      gallery()!
        .querySelector("[data-gallery-next]")!
        .getAttribute("aria-disabled"),
    ).toBe("true");
    press("ArrowRight");
    expect(position()).toBe("7 of 7");
    await settle();
  });

  it("has no previous or next for a single image", async () => {
    await renderTranscript([first]);
    act(() => thumbnails()[0].click());
    await settle();
    expect(position()).toBe("1 of 1");
    expect(gallery()!.querySelector("[data-gallery-next]")).toBeNull();
    expect(gallery()!.querySelector("[data-gallery-previous]")).toBeNull();
  });

  it("says so when the file is gone", async () => {
    await renderTranscript([first]);
    fs.readBinaryFile.mockRejectedValue(new Error("No such file"));
    __toolImageFilesTestReset();
    act(() => thumbnails()[0].click());
    await settle();
    expect(gallery()?.querySelector('[role="alert"]')?.textContent).toBe(
      "This image is no longer on disk.",
    );
  });

  it("closes when its image is deleted to make room", async () => {
    await renderTranscript();
    act(() => thumbnails()[0].click());
    await settle();
    expect(position()).toBe("1 of 7");
    await renderTranscript([user, many]);
    expect(gallery()).toBeNull();
  });

  it("opens nothing for an image no pane has", async () => {
    await renderTranscript();
    let opened = true;
    act(() => {
      opened = openToolImageGallery("elsewhere:0", null);
    });
    expect(opened).toBe(false);
    expect(gallery()).toBeNull();
  });
});

describe("PreviewSection", () => {
  async function renderPreview(shown: Block[]) {
    act(() =>
      root.render(
        createElement(
          Fragment,
          null,
          createElement(PreviewSection, { blocks: shown }),
          createElement(ToolImageGalleryHost, { blocks: shown }),
        ),
      ),
    );
    await settle();
  }

  function preview(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>("[data-preview-image]");
  }

  it("is absent until a tool call returns an image", async () => {
    await renderPreview([user, tool("bash", "npm test", 0)]);
    expect(container.querySelector("section")).toBeNull();
    expect(fs.readBinaryFile).not.toHaveBeenCalled();
  });

  it("shows the latest image and the call it came from", async () => {
    await renderPreview([user, first]);
    expect(
      container.querySelector('section[data-panel-section="Preview"]'),
    ).not.toBeNull();
    expect(preview()?.dataset.previewImage).toBe("shot:0");
    expect(preview()?.querySelector("img")?.getAttribute("src")).toBe(
      "blob:image-1",
    );
    expect(container.querySelector("[data-preview-title]")?.textContent).toBe(
      "Take a screenshot",
    );
    expect(container.querySelector("[data-preview-count]")).toBeNull();
    expect(fs.readBinaryFile).toHaveBeenCalledTimes(1);
  });

  it("follows the session as new images arrive", async () => {
    await renderPreview([user, first]);
    await renderPreview(blocks);
    expect(preview()?.dataset.previewImage).toBe("steps:5");
    expect(preview()?.querySelector("img")?.getAttribute("src")).toBe(
      "blob:image-2",
    );
    expect(container.querySelector("[data-preview-title]")?.textContent).toBe(
      "Screenshot every step",
    );
    expect(container.querySelector("[data-preview-count]")?.textContent).toBe(
      "7 images",
    );
  });

  it("keeps the last image up while the next one is read", async () => {
    await renderPreview([user, first]);
    let finish!: (bytes: Uint8Array) => void;
    fs.readBinaryFile.mockImplementationOnce(
      () =>
        new Promise<Uint8Array>((resolve) => {
          finish = resolve;
        }),
    );
    await renderPreview(blocks);
    expect(preview()?.dataset.previewImage).toBe("steps:5");
    expect(preview()?.querySelector("img")?.getAttribute("src")).toBe(
      "blob:image-1",
    );
    finish(PNG_BYTES);
    await settle();
    expect(preview()?.querySelector("img")?.getAttribute("src")).toBe(
      "blob:image-2",
    );
  });

  it("opens the gallery at the image it shows and takes focus back", async () => {
    await renderPreview(blocks);
    const opener = preview()!;
    act(() => opener.focus());
    act(() => opener.click());
    await settle();
    expect(position()).toBe("7 of 7");
    press("Escape");
    await settle();
    expect(gallery()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("can be folded away, and stays folded", async () => {
    await renderPreview(blocks);
    const fold = container.querySelector<HTMLButtonElement>(
      'section[data-panel-section="Preview"] h4 button',
    )!;
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    act(() => fold.click());
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(preview()).toBeNull();
    expect(localStorage.getItem("monocode.sessionPanel.previewCollapsed")).toBe(
      "1",
    );
  });
});

describe("the session panel", () => {
  function renderPanel(shown: Block[]) {
    act(() =>
      root.render(
        createElement(SessionPanelView, {
          session: { ...newSession("claude", "/home/tony/app"), blocks: shown },
          outputs: [],
          onClose: vi.fn(),
          onOpenFile: vi.fn(),
          onShowInChat: vi.fn(),
        }),
      ),
    );
  }

  function sections(): (string | undefined)[] {
    return [
      ...container.querySelectorAll<HTMLElement>("section[data-panel-section]"),
    ].map((section) => section.dataset.panelSection);
  }

  it("has a Preview section only for a session with tool-result images", async () => {
    renderPanel([user, tool("bash", "npm test", 0)]);
    await settle();
    expect(sections()).toEqual([
      "Outputs",
      "Used in this session",
      // #37: every chat with a project folder can start a preview.
      "Dev server",
      "Sandbox and privacy",
      "Session",
    ]);

    renderPanel(blocks);
    await settle();
    expect(sections()).toEqual([
      "Preview",
      "Outputs",
      "Used in this session",
      // #37: every chat with a project folder can start a preview.
      "Dev server",
      "Sandbox and privacy",
      "Session",
    ]);
  });
});
