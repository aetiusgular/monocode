import { useEffect, useMemo, useRef, useState } from "react";
import type { Block } from "../../sessions/model/session";
import {
  acquireToolImage,
  cachedToolImageThumbnail,
  loadToolImageThumbnail,
  releaseToolImage,
} from "../data/toolImageFiles";
import {
  sameSessionToolImages,
  sessionToolImages,
  type SessionToolImage,
} from "../model/sessionToolImages";

/**
 * A session's tool-result images. The list keeps its identity while the
 * images and their titles stay the same, so a streaming reply does not make
 * everything that shows them render again.
 */
export function useSessionToolImages(
  blocks: readonly Block[],
  cwd?: string,
): readonly SessionToolImage[] {
  const last = useRef<readonly SessionToolImage[]>([]);
  return useMemo(() => {
    const next = sessionToolImages(blocks, cwd);
    if (!sameSessionToolImages(last.current, next)) last.current = next;
    return last.current;
  }, [blocks, cwd]);
}

type Loaded = { path: string; url?: string; failed: boolean };

/**
 * The small image for a thumbnail. Nothing is read until `enabled`, so a row
 * far off screen costs nothing.
 */
export function useToolImageThumbnail(
  path: string,
  enabled = true,
): { url?: string; failed: boolean } {
  const [state, setState] = useState<Loaded>(() => ({
    path,
    url: cachedToolImageThumbnail(path),
    failed: false,
  }));
  const current: Loaded =
    state.path === path
      ? state
      : { path, url: cachedToolImageThumbnail(path), failed: false };
  const ready = current.url != null || current.failed;
  useEffect(() => {
    if (!enabled || ready) return;
    let stale = false;
    loadToolImageThumbnail(path).then(
      (url) => {
        if (!stale) setState({ path, url, failed: false });
      },
      () => {
        if (!stale) setState({ path, failed: true });
      },
    );
    return () => {
      stale = true;
    };
  }, [path, enabled, ready]);
  return { url: current.url, failed: current.failed };
}

/**
 * The full image for a path, or nothing for null. While the next image is
 * being read the last one stays up, so a preview that follows the newest
 * screenshot swaps from one to the next without going blank.
 */
export function useToolImage(path: string | null): {
  /** What to show now. May still be the previous path's image. */
  url?: string;
  /** The path `url` belongs to. */
  shownPath?: string;
  /** The image for `path` could not be read. */
  failed: boolean;
} {
  const [shown, setShown] = useState<{ path: string; url: string } | null>(
    null,
  );
  const [failedPath, setFailedPath] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let stale = false;
    acquireToolImage(path).then(
      (url) => {
        if (!stale) setShown({ path, url });
      },
      () => {
        if (!stale) setFailedPath(path);
      },
    );
    return () => {
      stale = true;
      // After the swap has rendered, so the image on screen is never revoked.
      setTimeout(() => releaseToolImage(path), 0);
    };
  }, [path]);
  if (!path) return { failed: false };
  return {
    url: shown?.url,
    shownPath: shown?.path,
    failed: failedPath === path,
  };
}
