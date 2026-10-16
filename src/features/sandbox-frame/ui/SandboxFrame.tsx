import { useEffect, useRef, useState } from "react";
import {
  frameUrlForToken,
  MAX_FRAME_DOCUMENT_BYTES,
  putFrameDocument,
  releaseFrameDocument,
} from "../../../platform/tauri/sandboxFrame";
import {
  frameMode,
  frameSandbox,
  utf8Length,
  withFrameMeta,
  type FrameMode,
} from "../model/frameDocument";
import {
  createFrameLoadGuard,
  FRAME_BLOCKED_NOTE,
  FRAME_RELOADED_NOTE,
} from "../model/frameLoads";

type Props = {
  /** The document to show. Treated as untrusted. */
  html: string;
  /** Accessible name for the frame. */
  title: string;
  className?: string;
  /** Wait this long after the last change before reloading, in ms. */
  debounceMs?: number;
  /** Override the stored mode, for tests and the static fallback. */
  mode?: FrameMode;
};

type FrameState =
  | { status: "loading" }
  | { status: "scheme"; src: string }
  | { status: "static"; srcDoc: string; note?: string }
  | { status: "error"; message: string };

/**
 * An untrusted HTML document in `<iframe sandbox="allow-scripts">` on the
 * `mcpreview` scheme: its scripts run, its fetches are blocked, and it gets an
 * opaque origin, so it cannot reach the app's commands (F5).
 *
 * Never shown as a window of its own, and never with `allow-same-origin`.
 */
export function SandboxFrame({
  html,
  title,
  className,
  debounceMs = 250,
  mode,
}: Props) {
  const effectiveMode = mode ?? frameMode();
  const [state, setState] = useState<FrameState>(() =>
    effectiveMode === "static"
      ? { status: "static", srcDoc: withFrameMeta(html) }
      : { status: "loading" },
  );
  // Security review K3: a page that navigates itself is loaded again once,
  // then not shown. A new document starts over.
  const loadGuard = useRef(createFrameLoadGuard()).current;
  const [frameKey, setFrameKey] = useState(0);
  const [leftPage, setLeftPage] = useState<"reloaded" | "blocked" | null>(null);
  const src = state.status === "scheme" ? state.src : undefined;
  useEffect(() => {
    loadGuard.reset();
    setLeftPage(null);
  }, [src, loadGuard]);

  useEffect(() => {
    if (utf8Length(html) > MAX_FRAME_DOCUMENT_BYTES) {
      setState({
        status: "error",
        message: "This document is larger than the preview holds (10 MB).",
      });
      return;
    }
    const document = withFrameMeta(html);
    if (effectiveMode === "static") {
      setState({ status: "static", srcDoc: document });
      return;
    }
    let cancelled = false;
    let token: string | null = null;
    const timer = setTimeout(() => {
      putFrameDocument(document).then(
        (next) => {
          if (cancelled) {
            void releaseFrameDocument(next);
            return;
          }
          token = next;
          setState({ status: "scheme", src: frameUrlForToken(next) });
        },
        () => {
          if (cancelled) return;
          // Outside the app (browser tests) or a store error: show the page
          // with no script at all rather than nothing.
          setState({
            status: "static",
            srcDoc: document,
            note: "Scripts are off in this preview.",
          });
        },
      );
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (token) void releaseFrameDocument(token);
    };
  }, [html, effectiveMode, debounceMs]);

  if (state.status === "error") {
    return (
      <p role="status" className="p-4 text-[13px] text-content/60">
        {state.message}
      </p>
    );
  }
  if (state.status === "loading") {
    return (
      <div
        aria-busy="true"
        className={`sandbox-frame ${className ?? ""}`}
        data-frame-mode="scripts"
      />
    );
  }
  if (state.status === "scheme" && leftPage === "blocked") {
    return (
      <p role="status" className="p-4 text-[13px] text-content/60">
        {FRAME_BLOCKED_NOTE}
      </p>
    );
  }
  return (
    <div className={`sandbox-frame flex min-h-0 flex-col ${className ?? ""}`}>
      {state.status === "scheme" && leftPage === "reloaded" ? (
        <p
          role="status"
          className="shrink-0 px-3 py-1 text-[12px] text-content/50"
        >
          {FRAME_RELOADED_NOTE}
        </p>
      ) : null}
      {state.status === "scheme" ? (
        <iframe
          key={frameKey}
          title={title}
          src={state.src}
          onLoad={() => {
            const load = loadGuard.onLoad();
            if (load === "block") setLeftPage("blocked");
            else if (load === "reload") {
              setLeftPage("reloaded");
              setFrameKey((key) => key + 1);
            }
          }}
          sandbox={frameSandbox("scripts")}
          referrerPolicy="no-referrer"
          className="sandbox-frame-view min-h-0 w-full flex-1 border-0 bg-white"
          data-frame-mode="scripts"
        />
      ) : (
        <iframe
          title={title}
          srcDoc={state.srcDoc}
          sandbox={frameSandbox("static")}
          referrerPolicy="no-referrer"
          className="sandbox-frame-view min-h-0 w-full flex-1 border-0 bg-white"
          data-frame-mode="static"
        />
      )}
      {state.status === "static" && state.note ? (
        <p className="shrink-0 px-3 py-1 text-[12px] text-content/50">
          {state.note}
        </p>
      ) : null}
    </div>
  );
}
