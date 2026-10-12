import { useEffect, useState } from "react";
import { requestAddToChat } from "../../sessions/model/quoteDraft";
import {
  noticeText,
  startDeepLinks,
  type DeepLinkDeps,
  type DeepLinkNotice,
} from "../model/deepLinkController";

const NOTICE_MS = 8_000;

async function tauriDeps(): Promise<Omit<DeepLinkDeps, "notify">> {
  const [{ getCurrent, onOpenUrl }, { getCurrentWebviewWindow }] =
    await Promise.all([
      import("@tauri-apps/plugin-deep-link"),
      import("@tauri-apps/api/webviewWindow"),
    ]);
  const window = getCurrentWebviewWindow();
  return {
    isMainWindow: () => window.label === "main",
    getCurrent,
    onOpenUrl,
    fill: (prompt) => requestAddToChat(prompt, "plain"),
    reveal: async () => {
      await window.unminimize().catch(() => {});
      await window.setFocus();
    },
  };
}

/**
 * Mounted beside the app in each workspace window. In the main window it
 * fills the prompt from a `monocode-harness://new?prompt=...` link and shows
 * a short notice. Must render after `App`, so App's add-to-chat listener is
 * in place before a link that started the app is delivered.
 */
export function DeepLinks({
  deps,
}: {
  /** Tests pass fakes. */
  deps?: Omit<DeepLinkDeps, "notify">;
}) {
  const [notice, setNotice] = useState<DeepLinkNotice | null>(null);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    const notify = (next: DeepLinkNotice) => {
      if (!disposed) setNotice(next);
    };
    const begin = (base: Omit<DeepLinkDeps, "notify">) => {
      if (disposed) return;
      stop = startDeepLinks({ ...base, notify });
    };
    if (deps) begin(deps);
    else void tauriDeps().then(begin, () => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, [deps]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (!notice) return null;
  return (
    <div
      role={notice.kind === "refused" ? "alert" : "status"}
      data-deep-link-notice={notice.kind}
      className="fixed bottom-4 left-1/2 z-50 flex max-w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-stroke bg-background-base px-3 py-2 text-[12px] text-content shadow-lg"
    >
      <span className="min-w-0">{noticeText(notice)}</span>
      <button
        type="button"
        onClick={() => setNotice(null)}
        className="shrink-0 rounded-md px-1.5 py-0.5 text-content/60 hover:bg-selection-hover hover:text-content"
      >
        Dismiss
      </button>
    </div>
  );
}
