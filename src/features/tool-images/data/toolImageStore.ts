import {
  deleteGeneratedImages,
  saveGeneratedImage,
} from "../../../platform/tauri/fs";
import type { HarnessEvent } from "../../../integrations/harness/core/types";
import {
  MAX_TOOL_IMAGE_DATA_CHARS,
  MAX_TOOL_IMAGES_PER_RESULT,
  MAX_TOOL_IMAGES_PER_SESSION,
  type ToolImageRef,
  type ToolResultImage,
} from "../model/toolImages";
import { pngBase64 } from "./imageCodec";

type ToolImagesEvent = Extract<HarnessEvent, { type: "tool.images" }>;

/**
 * Sessions whose tool-result images are not kept. The app sets this when it
 * loads (see the feature's index). It is a hook rather than an import so the
 * harness adapters, which also run on a remote host, do not pull the app's
 * own session model in with them.
 */
let skipped: (sessionId: string) => boolean = () => false;

export function skipToolImagesFor(
  predicate: (sessionId: string) => boolean,
): void {
  skipped = predicate;
}

/** Files saved for each session since the app started, oldest first. */
const savedBySession = new Map<string, string[]>();
/** One save at a time per session, so images land in the order they came. */
const queueBySession = new Map<string, Promise<void>>();

/**
 * Keeps a copy of the images a tool result carried, for the transcript only.
 * What the model was sent is not touched.
 *
 * The bytes go to the app's generated-image folder, the same place Codex's
 * generated images go, and the transcript gets a `tool.images` event with
 * their paths once they are saved. That folder only takes PNG, so a JPEG or
 * WebP screenshot is drawn again as PNG first.
 *
 * Bounds: the first `MAX_TOOL_IMAGES_PER_RESULT` images of a result, none
 * over `MAX_TOOL_IMAGE_DATA_CHARS`, and `MAX_TOOL_IMAGES_PER_SESSION` files
 * per session, counted from when the app started. Past that the oldest file
 * is deleted and the event says so, so the transcript lets go of it too.
 *
 * A Mono's conversation is skipped. It is stored page by page and deleting it
 * would leave most of these files behind. So is a session that runs on a
 * remote host: the host has no image folder, the save fails, and nothing is
 * reported.
 */
export function keepToolResultImages(input: {
  sessionId: string;
  /** The tool call whose row shows the images. */
  callId: string;
  /** The call the result answers, when that is a subagent's own call. */
  sourceId?: string;
  images: readonly ToolResultImage[];
  emit: (event: ToolImagesEvent) => void;
  /** False once the session has been stopped and wants nothing more. */
  wanted?: () => boolean;
}): Promise<void> {
  if (input.images.length === 0 || skipped(input.sessionId)) {
    return Promise.resolve();
  }
  const previous = queueBySession.get(input.sessionId) ?? Promise.resolve();
  const run = previous.then(() => keep(input)).catch(() => undefined);
  queueBySession.set(input.sessionId, run);
  void run.then(() => {
    if (queueBySession.get(input.sessionId) === run) {
      queueBySession.delete(input.sessionId);
    }
  });
  return run;
}

async function keep(
  input: Parameters<typeof keepToolResultImages>[0],
): Promise<void> {
  const saved: ToolImageRef[] = [];
  const candidates = input.images.slice(0, MAX_TOOL_IMAGES_PER_RESULT);
  for (const [index, image] of candidates.entries()) {
    if (!image.data || image.data.length > MAX_TOOL_IMAGE_DATA_CHARS) continue;
    try {
      const data = await pngBase64(image.data, image.mimeType);
      if (!data) continue;
      const asset = await saveGeneratedImage({
        data,
        name: "tool-image",
        sessionId: input.sessionId,
      });
      saved.push({
        id: `${input.sourceId ?? input.callId}:${index}`,
        path: asset.path,
        mimeType: asset.mimeType,
        size: asset.size,
      });
    } catch {
      // An image that cannot be saved is left out. The tool call still shows.
    }
  }
  if (saved.length === 0) return;
  const paths = saved.map((image) => image.path);
  if (input.wanted && !input.wanted()) {
    void deleteGeneratedImages(paths).catch(() => undefined);
    return;
  }
  const kept = savedBySession.get(input.sessionId) ?? [];
  kept.push(...paths);
  const dropped = kept.splice(
    0,
    Math.max(0, kept.length - MAX_TOOL_IMAGES_PER_SESSION),
  );
  savedBySession.set(input.sessionId, kept);
  if (dropped.length > 0) {
    void deleteGeneratedImages(dropped).catch(() => undefined);
  }
  input.emit({
    type: "tool.images",
    callId: input.callId,
    images: saved,
    ...(dropped.length > 0 ? { dropped } : {}),
  });
}

/** Test-only: forget every session's saved files. */
export function __toolImageStoreTestReset(): void {
  savedBySession.clear();
  queueBySession.clear();
  skipped = () => false;
}
