import { PanelSection } from "../../session-panel/ui/PanelSection";
import type { Block } from "../../sessions/model/session";
import {
  latestToolImage,
  type SessionToolImage,
} from "../model/sessionToolImages";
import { openToolImageGallery } from "./toolImageGalleryStore";
import { useSessionToolImages, useToolImage } from "./useToolImage";

/**
 * The session panel's live view: the newest image a tool call returned, with
 * the call it came from under it. It follows the session, so during a browser
 * run it shows each screenshot as it lands. A session whose tool calls have
 * returned no images has no such section.
 */
export function PreviewSection({
  blocks,
  cwd,
}: {
  blocks: readonly Block[];
  cwd?: string;
}) {
  const images = useSessionToolImages(blocks, cwd);
  const latest = latestToolImage(images);
  if (!latest) return null;
  return (
    <PanelSection title="Preview" fold="preview">
      <LatestImage image={latest} count={images.length} />
    </PanelSection>
  );
}

function LatestImage({
  image,
  count,
}: {
  image: SessionToolImage;
  count: number;
}) {
  const { url, failed } = useToolImage(image.ref.path);
  return (
    <div className="px-2">
      <button
        type="button"
        data-preview-image={image.ref.id}
        aria-label={`Open the latest image: ${image.title}`}
        title="Open in the gallery"
        className="block w-full cursor-zoom-in overflow-hidden rounded-lg border border-content/10 bg-content/5 hover:border-content/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        onClick={(event) =>
          openToolImageGallery(image.ref.id, event.currentTarget)
        }
      >
        {url ? (
          <img
            src={url}
            alt=""
            draggable={false}
            className="max-h-52 w-full object-contain"
          />
        ) : (
          <span className="flex h-28 items-center justify-center px-3 text-center text-[12px] text-content/40">
            {failed ? "This image is no longer on disk." : null}
          </span>
        )}
      </button>
      <div className="flex min-w-0 items-baseline gap-2 px-0.5 pt-1.5 text-[11.5px]">
        <span
          data-preview-title
          title={image.title}
          className="min-w-0 flex-1 truncate text-content/70"
        >
          {image.title}
        </span>
        {count > 1 ? (
          <span data-preview-count className="shrink-0 text-content/40">
            {count} images
          </span>
        ) : null}
      </div>
    </div>
  );
}
