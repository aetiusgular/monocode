import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { SandboxFrame } from "../../sandbox-frame/ui/SandboxFrame";

/** The rendered frame's height in px: its start, floor and ceiling. */
export const FRAME_HEIGHT = { initial: 360, min: 120, max: 1200 } as const;
const KEY_STEP = 40;

/** Kept between the floor, the ceiling and 80% of the window. */
export function clampFrameHeight(height: number, viewport: number): number {
  const ceiling = Math.max(
    FRAME_HEIGHT.min,
    Math.min(FRAME_HEIGHT.max, Math.floor(viewport * 0.8)),
  );
  return Math.round(Math.min(ceiling, Math.max(FRAME_HEIGHT.min, height)));
}

function viewportHeight(): number {
  return typeof window === "undefined" ? 1000 : window.innerHeight;
}

/**
 * A fenced `html` block with a "Render" button (#40). The page opens in the
 * sandboxed frame (F5): its scripts run, its fetches are blocked, and it has
 * no way into the app.
 *
 * `allowRender` is false for content written by strangers (inbox issues and
 * pull requests). There the block stays code, with no button.
 *
 * The frame resizes from the grip in its bottom corner (3.14). The iframe
 * covers the native CSS resizer and takes its pointer events, so the grip is
 * an element of its own, drawn over the frame.
 */
export function HtmlFence({
  code,
  incomplete,
  allowRender,
  source,
}: {
  code: string;
  incomplete: boolean;
  allowRender: boolean;
  source: ReactNode;
}) {
  const [rendered, setRendered] = useState(false);
  const [height, setHeight] = useState<number>(FRAME_HEIGHT.initial);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);
  if (!allowRender || incomplete || !code.trim()) return <>{source}</>;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { startY: event.clientY, startHeight: height };
    setDragging(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    setHeight(
      clampFrameHeight(
        start.startHeight + event.clientY - start.startY,
        viewportHeight(),
      ),
    );
  };
  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowDown"
        ? KEY_STEP
        : event.key === "ArrowUp"
          ? -KEY_STEP
          : 0;
    if (!step) return;
    event.preventDefault();
    setHeight((current) => clampFrameHeight(current + step, viewportHeight()));
  };

  return (
    <div className="markdown-visual" data-markdown-visual="html" dir="ltr">
      {rendered ? (
        <div
          className="markdown-visual-frame"
          data-resizing={dragging || undefined}
          style={{ height }}
        >
          <SandboxFrame
            html={code}
            title="HTML from the reply"
            className="h-full"
          />
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the rendered HTML"
            aria-valuemin={FRAME_HEIGHT.min}
            aria-valuemax={FRAME_HEIGHT.max}
            aria-valuenow={height}
            tabIndex={0}
            title="Drag to resize"
            className="markdown-visual-grip"
            data-markdown-visual-grip
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
            onKeyDown={onKeyDown}
          />
        </div>
      ) : (
        source
      )}
      <div className="markdown-visual-bar">
        <span>{rendered ? "Rendered in a sandbox, no network" : "HTML"}</span>
        <button type="button" onClick={() => setRendered((value) => !value)}>
          {rendered ? "Show source" : "Render"}
        </button>
      </div>
    </div>
  );
}
