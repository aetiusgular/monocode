import { memo, useEffect, useRef, useState } from "react";
import { Popover } from "../../../shared/ui/Popover";
import type { Block } from "../../sessions/model/session";
import { MAX_STRIP_THUMBNAILS, type ToolImageRef } from "../model/toolImages";
import { openToolImageGallery } from "./toolImageGalleryStore";
import { useToolImage, useToolImageThumbnail } from "./useToolImage";

/** How long the pointer rests on a thumbnail before the preview opens, in ms. */
const HOVER_OPEN_MS = 140;
/** How close to the viewport a strip gets before it reads its files, in px. */
const LOAD_MARGIN = "400px";

const PREVIEW_WIDTH = 360;

/**
 * The images a tool call returned, as a row of small thumbnails under its
 * row: at most four, then a chip counting the rest. Resting on one shows it
 * larger; clicking one opens the session's gallery there. A call that
 * returned no images renders nothing.
 */
export function ToolImageStrip({
  block,
  label,
  indent = false,
}: {
  block: Block;
  /** The tool call's title, for the thumbnails' accessible names. */
  label: string;
  /** Line the strip up with a row whose text sits right of an icon. */
  indent?: boolean;
}) {
  const images = block.toolImages;
  if (!images?.length) return null;
  return <Strip images={images} label={label} indent={indent} />;
}

const Strip = memo(function Strip({
  images,
  label,
  indent,
}: {
  images: readonly ToolImageRef[];
  label: string;
  indent: boolean;
}) {
  const near = useRef<HTMLDivElement | null>(null);
  const [load, setLoad] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  useEffect(() => {
    const element = near.current;
    if (load || !element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setLoad(true);
      },
      { rootMargin: LOAD_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [load]);

  const [hovered, setHovered] = useState<{
    image: ToolImageRef;
    anchor: HTMLElement;
  } | null>(null);
  const timer = useRef<number | null>(null);
  // The thumbnail the pointer is resting on, open or about to open, and where
  // the pointer last was.
  const resting = useRef<{
    image: ToolImageRef;
    anchor: HTMLElement;
    x: number;
    y: number;
  } | null>(null);
  const cancel = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);
  const rest = (image: ToolImageRef, anchor: HTMLElement, at: Point) => {
    const current = resting.current;
    if (current?.image.id === image.id) {
      // A move over the same thumbnail keeps its timer or open preview.
      current.anchor = anchor;
      current.x = at.clientX;
      current.y = at.clientY;
      return;
    }
    cancel();
    // Moving to another thumbnail closes this preview; that one opens after
    // its own rest.
    if (current) setHovered(null);
    resting.current = { image, anchor, x: at.clientX, y: at.clientY };
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setHovered({ image, anchor });
    }, HOVER_OPEN_MS);
  };
  const leave = () => {
    cancel();
    resting.current = null;
    setHovered(null);
  };
  const leaveRef = useRef(leave);
  leaveRef.current = leave;

  // Closes when the pointer really moves off the thumbnail and its preview.
  // Not on mouseleave: a thumbnail that changes width as its image loads, or
  // the preview appearing, fires leave events and fake moves at the same
  // pointer position (0.6, seen on Mac Chromium).
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const current = resting.current;
      if (!current) return;
      if (event.clientX === current.x && event.clientY === current.y) return;
      current.x = event.clientX;
      current.y = event.clientY;
      if (current.anchor.isConnected && within(current.anchor, event)) return;
      const preview = document.querySelector(
        `[data-tool-image-preview="${CSS.escape(current.image.id)}"]`,
      );
      if (preview && within(preview, event)) return;
      leaveRef.current();
    };
    const onWindowLeave = (event: MouseEvent) => {
      // Leaving the window has no related target and ends at its edge.
      if (event.relatedTarget != null) return;
      const { clientX: x, clientY: y } = event;
      if (x <= 0 || y <= 0 || x >= window.innerWidth || y >= window.innerHeight)
        leaveRef.current();
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseout", onWindowLeave, true);
    window.addEventListener("blur", leaveRef.current);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseout", onWindowLeave, true);
      window.removeEventListener("blur", leaveRef.current);
    };
  }, []);

  const shown = images.slice(0, MAX_STRIP_THUMBNAILS);
  const more = images.length - shown.length;
  return (
    <div
      ref={near}
      data-tool-images
      className={`flex min-w-0 flex-wrap items-center gap-1.5 pb-1.5 pt-0.5 ${
        indent ? "pl-5" : ""
      }`}
    >
      {shown.map((image, index) => (
        <Thumbnail
          key={image.id}
          image={image}
          load={load}
          label={`Open image ${index + 1} of ${images.length} from ${label}`}
          onRest={rest}
          onLeave={leave}
        />
      ))}
      {more > 0 ? (
        <button
          type="button"
          data-tool-images-more
          aria-label={`Open ${more} more ${more === 1 ? "image" : "images"} from ${label}`}
          title={`${more} more`}
          className="grid h-10 min-w-10 place-items-center rounded-md border border-content/10 bg-content/5 px-2 font-mono text-[11px] text-content/60 hover:bg-content/10 hover:text-content focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          onClick={(event) =>
            openToolImageGallery(images[shown.length].id, event.currentTarget)
          }
        >
          +{more}
        </button>
      ) : null}
      {hovered ? (
        <Popover
          // A fresh preview per thumbnail, so it grows from the one hovered.
          key={hovered.image.id}
          anchor={hovered.anchor}
          side="top"
          align="start"
          width={PREVIEW_WIDTH}
          aria-hidden
          data-tool-image-preview={hovered.image.id}
          className="pointer-events-none p-1.5"
        >
          <HoverPreview image={hovered.image} />
        </Popover>
      ) : null}
    </div>
  );
});

function Thumbnail({
  image,
  load,
  label,
  onRest,
  onLeave,
}: {
  image: ToolImageRef;
  load: boolean;
  label: string;
  onRest: (image: ToolImageRef, anchor: HTMLElement, at: Point) => void;
  onLeave: () => void;
}) {
  const { url, failed } = useToolImageThumbnail(image.path, load);
  // The file is gone: deleted to make room, or cleared with the app's data.
  if (failed) return null;
  return (
    <button
      type="button"
      data-tool-image={image.id}
      aria-label={label}
      className="flex h-10 min-w-10 max-w-28 cursor-zoom-in justify-center overflow-hidden rounded-md border border-content/10 bg-content/5 hover:border-content/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      onClick={(event) => {
        onLeave();
        openToolImageGallery(image.id, event.currentTarget);
      }}
      onPointerEnter={(event) => onRest(image, event.currentTarget, event)}
      onPointerMove={(event) => onRest(image, event.currentTarget, event)}
      onMouseEnter={(event) => onRest(image, event.currentTarget, event)}
    >
      {url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          decoding="async"
          className="h-full w-auto max-w-none"
        />
      ) : (
        <span className="block h-full w-14" />
      )}
    </button>
  );
}

/** The image at a readable size. The thumbnail stands in until it is read. */
function HoverPreview({ image }: { image: ToolImageRef }) {
  const thumbnail = useToolImageThumbnail(image.path);
  const full = useToolImage(image.path);
  const url = full.shownPath === image.path ? full.url : undefined;
  const src = url ?? thumbnail.url;
  if (!src) return <div className="h-40 rounded-lg bg-content/5" />;
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      className="max-h-64 w-full rounded-lg bg-content/5 object-contain"
    />
  );
}

type Point = { clientX: number; clientY: number };

/** Whether the pointer is over the element's box as laid out now. */
function within(element: Element, event: Point): boolean {
  const box = element.getBoundingClientRect();
  return (
    event.clientX >= box.left &&
    event.clientX < box.right &&
    event.clientY >= box.top &&
    event.clientY < box.bottom
  );
}
