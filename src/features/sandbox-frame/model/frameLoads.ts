/**
 * Security review K3: a sandboxed frame may not navigate its parent, but it
 * can navigate itself, to any address the app's frame list allows (a blob:
 * page, a localhost server). The parent cannot read where it went, but it
 * sees every load. The first load of a source is the page; another one means
 * the page left itself. It is loaded again once; a page that leaves again is
 * not shown.
 */
export type FrameLoad = "page" | "reload" | "block";

export function createFrameLoadGuard() {
  let loads = 0;
  let reloads = 0;
  return {
    /** Call from the frame's load event. */
    onLoad(): FrameLoad {
      loads += 1;
      if (loads === 1) return "page";
      if (reloads >= 1) return "block";
      reloads += 1;
      loads = 0;
      return "reload";
    },
    /** A new source (a new version or document) starts over. */
    reset(): void {
      loads = 0;
      reloads = 0;
    },
  };
}

export const FRAME_RELOADED_NOTE =
  "This page tried to open another page, so it was loaded again.";
export const FRAME_BLOCKED_NOTE =
  "This page kept opening other pages, so it is not shown.";
