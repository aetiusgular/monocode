import { openUrl } from "@tauri-apps/plugin-opener";
import { useState, useSyncExternalStore } from "react";
import { ExternalLink, RefreshCw } from "../../../shared/ui/icons";
import {
  isPreviewLive,
  previewForSession,
  previewsVersion,
  subscribePreviews,
  type AppPreview,
} from "../model/previewStore";
import { normalizePreviewUrl } from "../model/previewUrl";

/**
 * #37: the preview pane. An iframe on the chat's own server, on localhost.
 *
 * - The frame is sandboxed. It may run scripts, keep its own origin
 *   (`http://localhost:<port>`, never the app's) and submit forms. It may not
 *   show alerts or prompts (no `allow-modals`), which could pass for the
 *   app's own and ask for a password. It may not navigate the app's window
 *   (no `allow-top-navigation`),
 *   open windows (no `allow-popups`) or download files. "Open in browser" is
 *   there for those.
 * - The app's CSP allows `frame-src http://localhost:*` and nothing else
 *   new. An app that refuses framing gets a banner and "Open in browser".
 * - The pane never starts a server. With none running, it says so.
 */

/** What the frame may do. Exported for the tests. */
export const PREVIEW_FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms";

export function useAppPreview(sessionId: string): AppPreview | undefined {
  useSyncExternalStore(subscribePreviews, previewsVersion, previewsVersion);
  return previewForSession(sessionId);
}

function statusText(preview: AppPreview | undefined): string {
  if (!preview) return "No preview runs in this chat. Start one from the session panel.";
  switch (preview.status) {
    case "starting":
      return "Starting. Waiting for the server to print its address…";
    case "waiting":
      return `Waiting for ${preview.url ?? "the server"} to answer…`;
    case "ready":
      return "";
    case "stopped":
      return "The preview server has stopped. Start it again from the session panel.";
    case "failed":
      return `The preview server failed${preview.error ? `: ${preview.error}` : ""}.`;
  }
}

export function AppPreviewPane({ sessionId }: { sessionId: string }) {
  const preview = useAppPreview(sessionId);
  return <AppPreviewView preview={preview} />;
}

/** The pane for a given state; rendered on its own in tests. */
export function AppPreviewView({ preview }: { preview: AppPreview | undefined }) {
  const [reload, setReload] = useState(0);
  const url = preview?.url ? normalizePreviewUrl(preview.url) : undefined;
  const live = isPreviewLive(preview);
  const ready = live && preview?.status === "ready";
  const blocked = ready && preview?.frame?.blocked === true;
  const message = statusText(preview);
  return (
    <div
      data-app-preview
      data-app-preview-status={preview?.status ?? "none"}
      className="flex h-full min-h-0 min-w-0 flex-col bg-background-base font-sans"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-content/8 px-3 text-[12px]">
        <span
          aria-hidden
          className={`size-2 shrink-0 rounded-full ${
            ready ? "bg-emerald-500" : live ? "bg-amber-400" : "bg-content/25"
          }`}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-content/70" title={url}>
          {url ?? "No address yet"}
        </span>
        {preview?.httpStatus !== undefined ? (
          <span className="shrink-0 rounded bg-content/7 px-1.5 py-0.5 font-mono text-[10px] text-content/55">
            {preview.httpStatus}
          </span>
        ) : null}
        <button
          type="button"
          title="Reload the preview"
          aria-label="Reload the preview"
          disabled={!ready || blocked}
          className="grid size-6.5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/8 hover:text-content disabled:cursor-not-allowed disabled:opacity-35"
          onClick={() => setReload((value) => value + 1)}
        >
          <RefreshCw className="size-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          title="Open in browser"
          aria-label="Open in browser"
          disabled={!url || !live}
          data-app-preview-open
          className="grid size-6.5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/8 hover:text-content disabled:cursor-not-allowed disabled:opacity-35"
          onClick={() => {
            if (url) void openUrl(url).catch(() => undefined);
          }}
        >
          <ExternalLink className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {ready && url && !blocked ? (
          <iframe
            key={`${preview?.processId}:${reload}`}
            title="App preview"
            src={url}
            sandbox={PREVIEW_FRAME_SANDBOX}
            referrerPolicy="no-referrer"
            allow=""
            data-app-preview-frame
            className="absolute inset-0 h-full w-full border-0 bg-white"
          />
        ) : blocked ? (
          <div
            data-app-preview-blocked
            className="grid h-full place-items-center p-6 text-center"
          >
            <div className="flex max-w-sm flex-col items-center gap-3">
              <p className="text-[13px] text-content/75">
                This app does not allow itself to be shown inside another window.
              </p>
              {preview?.frame?.reason ? (
                <p className="font-mono text-[11px] text-content/45">
                  {preview.frame.reason}
                </p>
              ) : null}
              <button
                type="button"
                className="rounded-md bg-content px-3 py-1.5 text-[12px] font-medium text-background-base hover:bg-content/90"
                onClick={() => {
                  if (url) void openUrl(url).catch(() => undefined);
                }}
              >
                Open in browser
              </button>
            </div>
          </div>
        ) : (
          <div className="grid h-full place-items-center p-6 text-center">
            <p className="max-w-sm text-[13px] text-content/60" data-app-preview-message>
              {message}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
