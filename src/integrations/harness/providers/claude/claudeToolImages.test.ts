import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyHarnessEvent } from "../../core/apply";
import { newSession } from "../../../../features/sessions/model/session";
import { sanitizeSessionForPersist } from "../../../../features/sessions/data/sessionStore";
import type { HarnessEvent } from "../../core/types";

const child = vi.hoisted(() => {
  const sent: string[] = [];
  return {
    sent,
    onLine: undefined as ((line: string) => void) | undefined,
    writeChild: vi.fn(async (_id: string, line: string) => {
      sent.push(line);
    }),
  };
});
const { sent, writeChild } = child;

vi.mock("../../core/existingDirs", () => ({
  existingDirs: async (dirs?: readonly string[]) => [...(dirs ?? [])],
}));

vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    child.onLine = line;
  },
  writeChild: child.writeChild,
}));

const images = vi.hoisted(() => ({
  saveGeneratedImage: vi.fn(),
  deleteGeneratedImages: vi.fn(async (_paths: string[]) => undefined),
}));
vi.mock("../../../../platform/tauri/fs", async (original) => ({
  ...(await original<typeof import("../../../../platform/tauri/fs")>()),
  saveGeneratedImage: images.saveGeneratedImage,
  deleteGeneratedImages: images.deleteGeneratedImages,
}));

const { sendClaudeTurn, stopClaudeSession, __claudeTestReset } =
  await import("./claude");
const { toolResultsFromUserMessage } = await import("./claudeProtocol");
const { __toolImageStoreTestReset } =
  await import("../../../../features/tool-images/data/toolImageStore");

/** A real one-pixel PNG. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function pngBlock(data = PNG) {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data },
  };
}

function parse() {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function emit(rec: Record<string, unknown>) {
  child.onLine!(JSON.stringify(rec));
}

const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

async function startTurn(sessionId: string) {
  const events: HarnessEvent[] = [];
  const turn = sendClaudeTurn({
    sessionId,
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: "supervised",
    text: "check the page",
    attachments: [],
    onEvent: (event) => events.push(event),
  });
  await waitFor(
    () =>
      parse().some((m) => {
        const request = m.request as Record<string, unknown> | undefined;
        return request?.subtype === "initialize";
      }),
    "initialize",
  );
  emit({ type: "system", subtype: "init", session_id: "sess_1" });
  emit({
    type: "control_response",
    response: { subtype: "success", request_id: "monocode_1" },
  });
  await waitFor(() => parse().some((m) => m.type === "user"), "user prompt");
  return { events, turn };
}

function emitToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
  parent?: string,
) {
  emit({
    type: "assistant",
    session_id: "sess_1",
    ...(parent ? { parent_tool_use_id: parent } : {}),
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
}

function emitToolResult(id: string, content: unknown, parent?: string) {
  emit({
    type: "user",
    session_id: "sess_1",
    ...(parent ? { parent_tool_use_id: parent } : {}),
    message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
  });
}

function imageEvents(events: HarnessEvent[]) {
  return events.filter(
    (event): event is Extract<HarnessEvent, { type: "tool.images" }> =>
      event.type === "tool.images",
  );
}

let saved = 0;

beforeEach(() => {
  sent.length = 0;
  child.onLine = undefined;
  saved = 0;
  writeChild.mockClear();
  images.deleteGeneratedImages.mockClear();
  images.saveGeneratedImage.mockReset();
  images.saveGeneratedImage.mockImplementation(
    async (input: { data: string }) => ({
      path: `/data/generated-images/${++saved}.png`,
      mimeType: "image/png",
      size: input.data.length,
    }),
  );
  __toolImageStoreTestReset();
  __claudeTestReset();
});

afterEach(async () => {
  await stopClaudeSession("s1");
  __claudeTestReset();
});

describe("toolResultsFromUserMessage", () => {
  function results(content: unknown) {
    return toolResultsFromUserMessage({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content }],
      },
    });
  }

  it("reads a text-only result exactly as before", () => {
    expect(results("clean")).toEqual([
      { toolUseId: "toolu_1", isError: false, text: "clean" },
    ]);
    expect(results([{ type: "text", text: "a" }, "b"])).toEqual([
      { toolUseId: "toolu_1", isError: false, text: "ab" },
    ]);
    expect(results(undefined)).toEqual([
      { toolUseId: "toolu_1", isError: false, text: "" },
    ]);
  });

  it("keeps the images beside the text", () => {
    expect(
      results([
        { type: "text", text: "Took the screenshot." },
        pngBlock(),
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: "/9j/4A==",
          },
        },
      ]),
    ).toEqual([
      {
        toolUseId: "toolu_1",
        isError: false,
        text: "Took the screenshot.",
        images: [
          { data: PNG, mimeType: "image/png" },
          { data: "/9j/4A==", mimeType: "image/jpeg" },
        ],
      },
    ]);
  });

  it("takes only inline images in a format Claude accepts", () => {
    expect(
      results([
        { type: "image", source: { type: "url", url: "https://x.test/a.png" } },
        {
          type: "image",
          source: { type: "base64", media_type: "image/svg+xml", data: "PHN2" },
        },
        { type: "image", source: { type: "base64", media_type: "image/png" } },
        { type: "image" },
      ]),
    ).toEqual([{ toolUseId: "toolu_1", isError: false, text: "" }]);
  });
});

describe("claude tool-result images", () => {
  it("saves a screenshot and puts it on the tool call's row", async () => {
    const { events, turn } = await startTurn("s1");
    const before = sent.length;
    emitToolUse("toolu_shot", "mcp__playwright__browser_take_screenshot", {});
    emitToolResult("toolu_shot", [
      { type: "text", text: "Took the screenshot." },
      pngBlock(),
    ]);
    await waitFor(() => imageEvents(events).length > 0, "tool.images");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    // The result row is what it would be without the image.
    const updated = events.filter(
      (event) => event.type === "tool.updated" && event.status === "completed",
    );
    expect(updated).toEqual([
      expect.objectContaining({
        callId: "toolu_shot",
        detail: "Took the screenshot.",
      }),
    ]);
    expect(images.saveGeneratedImage).toHaveBeenCalledWith({
      data: PNG,
      name: "tool-image",
    });
    expect(imageEvents(events)).toEqual([
      {
        type: "tool.images",
        callId: "toolu_shot",
        images: [
          {
            id: "toolu_shot:0",
            path: "/data/generated-images/1.png",
            mimeType: "image/png",
            size: PNG.length,
          },
        ],
      },
    ]);
    // No event carries the bytes, and nothing was written back to Claude.
    expect(JSON.stringify(events)).not.toContain(PNG);
    expect(sent.length).toBe(before);

    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    const row = session.blocks.find(
      (block) => block.tool?.callId === "toolu_shot",
    );
    expect(row?.tool?.status).toBe("completed");
    expect(row?.tool?.detail).toBe("Took the screenshot.");
    expect(row?.toolImages).toEqual([
      {
        id: "toolu_shot:0",
        path: "/data/generated-images/1.png",
        mimeType: "image/png",
        size: PNG.length,
      },
    ]);

    // Saved with the session as a path, never as image data.
    const persisted = sanitizeSessionForPersist(session);
    const persistedRow = persisted.blocks.find(
      (block) => block.tool?.callId === "toolu_shot",
    );
    expect(persistedRow?.toolImages).toEqual(row?.toolImages);
    expect(JSON.stringify(persisted)).not.toContain(PNG);
  });

  it("emits nothing extra for a result without images", async () => {
    const { events, turn } = await startTurn("s1");
    emitToolUse("toolu_shell", "Bash", { command: "git status --short" });
    emitToolResult("toolu_shell", "clean");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
    await new Promise((r) => setTimeout(r, 20));
    expect(images.saveGeneratedImage).not.toHaveBeenCalled();
    expect(imageEvents(events)).toEqual([]);
    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    expect(
      session.blocks.find((block) => block.tool?.callId === "toolu_shell"),
    ).not.toHaveProperty("toolImages");
  });

  it("puts a subagent's screenshots on the subagent's row", async () => {
    const { events, turn } = await startTurn("s1");
    emitToolUse("toolu_agent", "Agent", {
      description: "Check the mobile layout",
      subagent_type: "general-purpose",
    });
    emitToolUse(
      "toolu_inner",
      "mcp__playwright__browser_take_screenshot",
      {},
      "toolu_agent",
    );
    emitToolResult("toolu_inner", [pngBlock()], "toolu_agent");
    await waitFor(() => imageEvents(events).length > 0, "tool.images");
    emitToolResult("toolu_agent", "The layout holds.");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    expect(imageEvents(events)).toEqual([
      expect.objectContaining({
        callId: "toolu_agent",
        images: [expect.objectContaining({ id: "toolu_inner:0" })],
      }),
    ]);
    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    const row = session.blocks.find(
      (block) => block.tool?.callId === "toolu_agent",
    );
    expect(row?.toolImages?.map((image) => image.id)).toEqual([
      "toolu_inner:0",
    ]);
    expect(row?.agentRun?.steps.some((step) => step.id === "toolu_inner")).toBe(
      true,
    );
  });

  it("drops an image whose session stopped while it was being saved", async () => {
    const { events, turn } = await startTurn("s1");
    void turn.catch(() => undefined);
    let finish: (() => void) | undefined;
    images.saveGeneratedImage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              path: "/data/generated-images/late.png",
              mimeType: "image/png",
              size: 1,
            });
        }),
    );
    emitToolUse("toolu_shot", "mcp__playwright__browser_take_screenshot", {});
    emitToolResult("toolu_shot", [pngBlock()]);
    await waitFor(() => finish !== undefined, "save to start");
    await stopClaudeSession("s1");
    finish!();
    await waitFor(
      () => images.deleteGeneratedImages.mock.calls.length > 0,
      "cleanup",
    );
    expect(images.deleteGeneratedImages).toHaveBeenCalledWith([
      "/data/generated-images/late.png",
    ]);
    expect(imageEvents(events)).toEqual([]);
  });
});
