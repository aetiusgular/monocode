import {
  listen,
  type EventCallback,
  type UnlistenFn,
} from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/**
 * Menu items that act in one window. Rust sends them to the focused window
 * only (`emit_to_focused` in menu.rs), but a plain `listen` is registered for
 * any target and hears an event sent to any window. So one View, Reload
 * reloaded every window (Mac 4.14), and New Tab or Close Tab acted in each.
 */
export const WINDOW_MENU_EVENTS: ReadonlySet<string> = new Set([
  "new_tab",
  "close_tab",
  "toggle_sidebar",
  "toggle_session_sidebar",
  "zoom_in",
  "zoom_out",
  "zoom_reset",
  "reload",
  "open_command_palette",
  "close_all_tabs",
]);

/** Listen for a menu event, in this window only when the item targets one. */
export function listenMenu<T>(
  event: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  return WINDOW_MENU_EVENTS.has(event)
    ? getCurrentWebviewWindow().listen<T>(event, handler)
    : listen<T>(event, handler);
}
