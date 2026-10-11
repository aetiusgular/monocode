import { describe, expect, it } from "vitest";
import type { Block } from "../../sessions/model/session";
import {
  latestToolImage,
  sameSessionToolImages,
  sessionToolImages,
} from "./sessionToolImages";
import {
  attachToolImages,
  MAX_TOOL_IMAGES_PER_SESSION,
  sanitizeToolImages,
  sessionImagePaths,
  toolImagePaths,
  type ToolImageRef,
} from "./toolImages";

function image(id: string): ToolImageRef {
  return {
    id,
    path: `/data/generated-images/${id}.png`,
    mimeType: "image/png",
    size: 1024,
  };
}

function tool(callId: string, patch: Partial<Block> = {}): Block {
  return {
    id: `block_${callId}`,
    role: "tool",
    text: `Call ${callId}`,
    tool: { callId, title: `Call ${callId}`, kind: "other" },
    ...patch,
  };
}

const prose: Block = { id: "prose", role: "assistant", text: "Looking." };

describe("attachToolImages", () => {
  it("puts images on the call they came from and leaves the rest alone", () => {
    const blocks = [prose, tool("a"), tool("b")];
    const next = attachToolImages(blocks, "b", [image("b:0"), image("b:1")]);
    expect(next).not.toBe(blocks);
    expect(next[0]).toBe(prose);
    expect(next[1]).toBe(blocks[1]);
    expect(next[2].toolImages).toEqual([image("b:0"), image("b:1")]);
    expect(next[2].tool).toBe(blocks[2].tool);
  });

  it("adds to what the call already has and skips repeats", () => {
    const blocks = [tool("a", { toolImages: [image("a:0")] })];
    const next = attachToolImages(blocks, "a", [image("a:0"), image("a:1")]);
    expect(next[0].toolImages?.map((entry) => entry.id)).toEqual([
      "a:0",
      "a:1",
    ]);
    expect(attachToolImages(next, "a", [image("a:1")])).toBe(next);
  });

  it("returns the same blocks when the call is not in the transcript", () => {
    const blocks = [prose, tool("a")];
    expect(attachToolImages(blocks, "gone", [image("x:0")])).toBe(blocks);
    expect(attachToolImages(blocks, "a", [])).toBe(blocks);
  });

  it("takes deleted files off every call that had them", () => {
    const blocks = [
      tool("a", { toolImages: [image("a:0")] }),
      tool("b", { toolImages: [image("b:0"), image("b:1")] }),
      tool("c"),
    ];
    const next = attachToolImages(
      blocks,
      "c",
      [image("c:0")],
      [image("a:0").path, image("b:0").path],
    );
    expect(next[0]).not.toHaveProperty("toolImages");
    expect(next[1].toolImages).toEqual([image("b:1")]);
    expect(next[2].toolImages).toEqual([image("c:0")]);
  });
});

describe("sessionToolImages", () => {
  it("lists every image oldest first, with its call's title", () => {
    const blocks = [
      prose,
      tool("a", { toolImages: [image("a:0")] }),
      tool("b"),
      tool("c", { toolImages: [image("c:0"), image("c:1")] }),
    ];
    const images = sessionToolImages(blocks);
    expect(images.map((entry) => entry.ref.id)).toEqual(["a:0", "c:0", "c:1"]);
    expect(images.map((entry) => entry.blockId)).toEqual([
      "block_a",
      "block_c",
      "block_c",
    ]);
    expect(images[0].title).toBe("Call a");
    expect(latestToolImage(images)?.ref.id).toBe("c:1");
  });

  it("names a subagent's images after the subagent", () => {
    const agent = tool("agent", {
      text: "Check the mobile layout",
      tool: {
        callId: "agent",
        title: "Check the mobile layout",
        kind: "agent",
      },
      agentRun: { name: "Check the mobile layout", steps: [] },
      toolImages: [image("step:0")],
    });
    expect(sessionToolImages([agent])[0].title).toBe("Check the mobile layout");
  });

  it("is empty, and the same empty list, for a session without images", () => {
    const first = sessionToolImages([prose, tool("a")]);
    expect(first).toEqual([]);
    expect(sessionToolImages([prose])).toBe(first);
    expect(latestToolImage(first)).toBeNull();
  });

  it("tells an unchanged list from a changed one", () => {
    const blocks = [tool("a", { toolImages: [image("a:0")] })];
    const before = sessionToolImages(blocks);
    // The same call, streamed past: a new array of the same blocks.
    expect(sameSessionToolImages(before, sessionToolImages([...blocks]))).toBe(
      true,
    );
    const grown = attachToolImages(blocks, "a", [image("a:1")]);
    expect(sameSessionToolImages(before, sessionToolImages(grown))).toBe(false);
  });
});

describe("image paths", () => {
  it("collects generated images and tool-result images for deletion", () => {
    const blocks: Block[] = [
      {
        id: "generated",
        role: "image",
        text: "",
        image: {
          path: "/data/generated-images/made.png",
          name: "made.png",
          mimeType: "image/png",
          size: 9,
        },
      },
      tool("a", { toolImages: [image("a:0")] }),
      prose,
    ];
    expect(toolImagePaths(blocks)).toEqual([image("a:0").path]);
    expect(sessionImagePaths(blocks)).toEqual([
      "/data/generated-images/made.png",
      image("a:0").path,
    ]);
  });
});

describe("sanitizeToolImages", () => {
  it("keeps well-formed references and nothing else", () => {
    expect(
      sanitizeToolImages([
        image("a:0"),
        { ...image("a:1"), data: "iVBORw0KGgo=", extra: true },
        { ...image("a:0") },
        { ...image("a:2"), path: "" },
        { ...image("a:3"), mimeType: "text/html" },
        { ...image("a:4"), size: -1 },
        "not an image",
        null,
      ]),
    ).toEqual([image("a:0"), image("a:1")]);
  });

  it("is undefined for nothing usable", () => {
    expect(sanitizeToolImages(undefined)).toBeUndefined();
    expect(sanitizeToolImages("x")).toBeUndefined();
    expect(sanitizeToolImages([{ id: "a" }])).toBeUndefined();
  });

  it("bounds how many one block can carry", () => {
    const many = Array.from(
      { length: MAX_TOOL_IMAGES_PER_SESSION + 5 },
      (_, index) => image(`a:${index}`),
    );
    const kept = sanitizeToolImages(many)!;
    expect(kept).toHaveLength(MAX_TOOL_IMAGES_PER_SESSION);
    expect(kept[kept.length - 1].id).toBe(
      `a:${MAX_TOOL_IMAGES_PER_SESSION + 4}`,
    );
  });
});
