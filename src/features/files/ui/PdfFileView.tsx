import { useCallback, useEffect, useState } from "react";
import { AlertCircle } from "../../../shared/ui/icons";
import {
  basename,
  openPathWithDefaultApp,
  readBinaryFile,
} from "../../../platform/tauri/fs";
import { formatFileSize, isPdfBytes } from "../model/filePreview";
import { watchFile } from "../model/fileWatch";

/** Larger files open in the default app instead of being copied into memory. */
export const MAX_PDF_PREVIEW_BYTES = 64 * 1024 * 1024;

type LoadState =
  | { status: "loading" }
  | { status: "ready"; url: string; size: number }
  | { status: "unsupported"; reason: string }
  | { status: "error"; message: string };

/**
 * A PDF in a frame on a blob URL (#35), read by the webview's own PDF viewer.
 *
 * The bytes must start like a PDF, and the blob is always typed
 * `application/pdf`, so markup saved as `.pdf` never becomes a document. The
 * frame carries no `sandbox` attribute: a sandboxed frame blocks the PDF
 * plugin by spec. Whether WebKit renders it is check 35-PDF on the Mac. If it
 * does not, "Open in default app" is the way, and pdf.js comes after.
 */
export function PdfFileView({ path }: { path: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    setState({ status: "loading" });
    readBinaryFile(path).then(
      (bytes) => {
        if (cancelled) return;
        if (bytes.byteLength > MAX_PDF_PREVIEW_BYTES) {
          setState({
            status: "unsupported",
            reason: `${formatFileSize(bytes.byteLength)} is too large to preview here.`,
          });
          return;
        }
        if (!isPdfBytes(bytes)) {
          setState({
            status: "unsupported",
            reason: "This file does not start like a PDF.",
          });
          return;
        }
        created = URL.createObjectURL(
          new Blob([bytes], { type: "application/pdf" }),
        );
        setState({ status: "ready", url: created, size: bytes.byteLength });
      },
      (cause: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      },
    );
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [path, reloadKey]);

  const reload = useCallback(() => setReloadKey((value) => value + 1), []);

  useEffect(() => {
    let timer = 0;
    const stop = watchFile(path, () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(reload, 50);
    });
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [path, reload]);

  const openExternally = () => {
    void openPathWithDefaultApp(path).catch(() => undefined);
  };

  if (state.status === "loading") {
    return (
      <div className="grid h-full place-items-center text-[12px] text-content/45">
        Opening {basename(path)}…
      </div>
    );
  }

  if (state.status !== "ready") {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="max-w-sm text-[13px] text-content/70">
          <AlertCircle className="mx-auto mb-3 size-5 text-content/40" />
          <p className="font-medium text-content">{basename(path)}</p>
          <p className="mt-1 text-content/55">
            {state.status === "error" ? state.message : state.reason}
          </p>
          <button
            type="button"
            className="mt-3 rounded-md border border-stroke px-2.5 py-1 text-[12px] hover:bg-content/8"
            onClick={openExternally}
          >
            Open in default app
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <iframe
        title={`PDF ${basename(path)}`}
        src={state.url}
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0 bg-white"
        data-pdf-frame=""
      />
      <div className="flex shrink-0 items-center justify-between border-t border-stroke px-3 py-1 text-[12px] text-content/55">
        <span>{formatFileSize(state.size)}</span>
        <button
          type="button"
          className="rounded px-1.5 py-0.5 hover:bg-content/8 hover:text-content"
          onClick={openExternally}
        >
          Open in default app
        </button>
      </div>
    </div>
  );
}
