import { useCallback, useEffect, useRef, useState } from "react";
import { ImageLightbox } from "../../../shared/ui/ImageLightbox";
import { ChevronLeft, ChevronRight } from "../../../shared/ui/icons";
import type { Block } from "../../sessions/model/session";
import type { SessionToolImage } from "../model/sessionToolImages";
import {
  registerToolImageGalleryHost,
  type ToolImageGalleryRequest,
} from "./toolImageGalleryStore";
import { useSessionToolImages, useToolImage } from "./useToolImage";

/** Shown for the moment before the first image has been read. */
const BLANK =
  "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

const STEP_BUTTON =
  "absolute top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full border border-white/15 bg-black/45 text-white/80 shadow-lg backdrop-blur-md hover:bg-black/65 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 aria-disabled:cursor-default aria-disabled:opacity-30 aria-disabled:hover:bg-black/45 aria-disabled:hover:text-white/80";

/**
 * The pane's gallery of tool-result images. It renders nothing until a
 * thumbnail of this session asks for it (see `openToolImageGallery`).
 */
export function ToolImageGalleryHost({
  blocks,
  cwd,
}: {
  blocks: readonly Block[];
  cwd?: string;
}) {
  const images = useSessionToolImages(blocks, cwd);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const [request, setRequest] = useState<ToolImageGalleryRequest | null>(null);
  const requestRef = useRef(request);
  requestRef.current = request;

  useEffect(
    () =>
      registerToolImageGalleryHost({
        has: (imageId) =>
          imagesRef.current.some((image) => image.ref.id === imageId),
        open: setRequest,
      }),
    [],
  );

  const close = useCallback(() => {
    const opener = requestRef.current?.opener;
    setRequest(null);
    if (!opener) return;
    // After the gallery has left, so its own focus handling does not win.
    requestAnimationFrame(() => {
      if (opener.isConnected) opener.focus({ preventScroll: true });
    });
  }, []);

  const select = useCallback((imageId: string) => {
    setRequest((current) => (current ? { ...current, imageId } : current));
  }, []);

  const index = request
    ? images.findIndex((image) => image.ref.id === request.imageId)
    : -1;
  // The image on show was deleted to make room for newer ones.
  useEffect(() => {
    if (request && index < 0) close();
  }, [request, index, close]);

  if (!request || index < 0) return null;
  return (
    <ToolImageGallery
      images={images}
      index={index}
      onSelect={select}
      onClose={close}
    />
  );
}

/**
 * One image at a time, full screen, with the others a key away: Left and
 * Right step through them, Escape closes. Zooming is the lightbox's own.
 */
export function ToolImageGallery({
  images,
  index,
  onSelect,
  onClose,
}: {
  images: readonly SessionToolImage[];
  index: number;
  onSelect: (imageId: string) => void;
  onClose: () => void;
}) {
  const image = images[index];
  const total = images.length;
  const { url, failed } = useToolImage(image.ref.path);

  const step = useCallback(
    (by: number) => {
      const next = images[index + by];
      if (next) onSelect(next.ref.id);
    },
    [images, index, onSelect],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      step(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [step]);

  const position = `${index + 1} of ${total}`;
  return (
    <ImageLightbox
      src={failed ? BLANK : (url ?? BLANK)}
      alt={`${image.title}, image ${position}`}
      onClose={onClose}
    >
      {failed ? (
        <p
          role="alert"
          className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-[13px] text-white/70"
        >
          This image is no longer on disk.
        </p>
      ) : null}
      {total > 1 ? (
        <>
          <button
            type="button"
            aria-label="Previous image"
            title="Previous image"
            data-gallery-previous
            // Not `disabled`: the button keeps focus at either end.
            aria-disabled={index === 0}
            onClick={() => step(-1)}
            className={`${STEP_BUTTON} left-4`}
          >
            <ChevronLeft className="size-5" strokeWidth={2} />
          </button>
          <button
            type="button"
            aria-label="Next image"
            title="Next image"
            data-gallery-next
            aria-disabled={index === total - 1}
            onClick={() => step(1)}
            className={`${STEP_BUTTON} right-4`}
          >
            <ChevronRight className="size-5" strokeWidth={2} />
          </button>
        </>
      ) : null}
      <div
        data-gallery-caption
        className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-16"
      >
        <div className="flex min-w-0 max-w-full items-center gap-2.5 rounded-full border border-white/15 bg-black/55 px-3.5 py-1.5 text-[12px] text-white/85 shadow-lg backdrop-blur-md">
          <span
            data-gallery-position
            aria-live="polite"
            className="shrink-0 font-mono text-[11px] tabular-nums text-white/70"
          >
            {position}
          </span>
          <span className="min-w-0 truncate">{image.title}</span>
        </div>
      </div>
    </ImageLightbox>
  );
}
