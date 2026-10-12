import { parseDeepLink } from "./deepLink";
import { DeepLinkInbox, type LinkSource } from "./deepLinkInbox";

/** At most this many links act from one delivery; the rest are ignored. */
export const MAX_LINKS_PER_DELIVERY = 5;

export type DeepLinkNotice =
  { kind: "filled"; removed: number } | { kind: "refused"; reason: string };

export type DeepLinkDeps = {
  /** Only the main window handles links, so a link acts once. */
  isMainWindow: () => boolean;
  /** Links that started the app, or the last one seen (plugin `getCurrent`). */
  getCurrent: () => Promise<string[] | null>;
  /** Links opened while the app runs (plugin `onOpenUrl`). */
  onOpenUrl: (handler: (urls: string[]) => void) => Promise<() => void>;
  /** Puts the prompt in the composer. Never sends. */
  fill: (prompt: string) => void;
  /** Brings the window forward. Failures are ignored. */
  reveal: () => Promise<void>;
  notify: (notice: DeepLinkNotice) => void;
  inbox?: DeepLinkInbox;
};

/**
 * Starts listening for deep links. Returns a stop function. Nothing happens
 * outside the main window.
 */
export function startDeepLinks(deps: DeepLinkDeps): () => void {
  if (!deps.isMainWindow()) return () => {};
  const inbox = deps.inbox ?? new DeepLinkInbox();
  let stopped = false;
  let unlisten: (() => void) | undefined;

  const handle = (urls: unknown, source: LinkSource) => {
    if (stopped || !Array.isArray(urls)) return;
    let acted = false;
    for (const url of urls.slice(0, MAX_LINKS_PER_DELIVERY)) {
      if (typeof url !== "string") continue;
      if (!inbox.accept(url, source)) continue;
      const result = parseDeepLink(url);
      if (result.ok) {
        deps.fill(result.prompt);
        deps.notify({ kind: "filled", removed: result.removed });
        acted = true;
      } else {
        deps.notify({ kind: "refused", reason: result.reason });
      }
    }
    if (acted) void deps.reveal().catch(() => {});
  };

  void deps
    .onOpenUrl((urls) => handle(urls, "event"))
    .then((stop) => {
      if (stopped) stop();
      else unlisten = stop;
    })
    .catch(() => {});
  void deps
    .getCurrent()
    .then((urls) => handle(urls ?? [], "launch"))
    .catch(() => {});

  return () => {
    stopped = true;
    unlisten?.();
  };
}

export function noticeText(notice: DeepLinkNotice): string {
  if (notice.kind === "refused") return `A link was not used. ${notice.reason}`;
  const hidden =
    notice.removed > 0
      ? ` ${notice.removed} hidden character${notice.removed === 1 ? " was" : "s were"} removed.`
      : "";
  return `A link filled the prompt. Read it before you send.${hidden}`;
}
