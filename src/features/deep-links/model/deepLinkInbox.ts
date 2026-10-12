/**
 * Makes each deep link act once in the main window.
 *
 * - The plugin's `getCurrent` keeps returning the last link it saw, so a
 *   reload (corner case 14) would fill the prompt again. Links read through
 *   `getCurrent` are remembered for the life of the window, in
 *   `sessionStorage`, and never act twice.
 * - On macOS a link that starts the app can arrive both through `getCurrent`
 *   and as an event. The same link within `REPEAT_WINDOW_MS` acts once.
 * - The same link clicked again later, while the app runs, acts again.
 */

export const HANDLED_KEY = "monocode.deepLinks.handled";
export const HANDLED_LIMIT = 50;
export const REPEAT_WINDOW_MS = 5_000;

export type LinkSource = "launch" | "event";

export type InboxStorage = Pick<Storage, "getItem" | "setItem">;

function sessionStore(): InboxStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function readHandled(storage: InboxStorage | null): string[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(HANDLED_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function writeHandled(storage: InboxStorage | null, links: string[]) {
  if (!storage) return;
  try {
    storage.setItem(HANDLED_KEY, JSON.stringify(links.slice(-HANDLED_LIMIT)));
  } catch {
    // Storage full or blocked: the in-memory guard still holds for this load.
  }
}

export class DeepLinkInbox {
  private readonly handled: string[];
  private last: { link: string; at: number } | null = null;

  constructor(
    private readonly storage: InboxStorage | null = sessionStore(),
    private readonly now: () => number = Date.now,
  ) {
    this.handled = readHandled(storage);
  }

  /** True when the link should act now. Records it either way. */
  accept(link: string, source: LinkSource): boolean {
    const at = this.now();
    const repeat =
      this.last !== null &&
      this.last.link === link &&
      at - this.last.at < REPEAT_WINDOW_MS;
    const seenAtLaunch = source === "launch" && this.handled.includes(link);
    this.last = { link, at };
    if (!this.handled.includes(link)) {
      this.handled.push(link);
      if (this.handled.length > HANDLED_LIMIT) this.handled.shift();
      writeHandled(this.storage, this.handled);
    }
    return !repeat && !seenAtLaunch;
  }
}
