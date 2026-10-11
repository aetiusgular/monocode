/**
 * How a thumbnail asks for the gallery. Thumbnails sit deep in the transcript
 * and in the session panel; the gallery itself is mounted once per pane,
 * where the whole session is in reach. A thumbnail names an image and the
 * pane whose session has that image opens on it.
 */

export type ToolImageGalleryRequest = {
  imageId: string;
  /** Gets focus back when the gallery closes. */
  opener: HTMLElement | null;
};

type GalleryHost = {
  has: (imageId: string) => boolean;
  open: (request: ToolImageGalleryRequest) => void;
};

const hosts = new Set<GalleryHost>();

export function registerToolImageGalleryHost(host: GalleryHost): () => void {
  hosts.add(host);
  return () => {
    hosts.delete(host);
  };
}

/** Opens the gallery on an image. False when no pane on screen has it. */
export function openToolImageGallery(
  imageId: string,
  opener: HTMLElement | null,
): boolean {
  for (const host of hosts) {
    if (!host.has(imageId)) continue;
    host.open({ imageId, opener });
    return true;
  }
  return false;
}
