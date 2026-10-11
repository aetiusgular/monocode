import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Brings the app window back in front, for example after a sign-in finished
 * in the browser. Does nothing outside the app.
 */
export async function bringAppToFront(): Promise<void> {
  if (!isTauri()) return;
  const win = getCurrentWindow();
  await win.unminimize().catch(() => undefined);
  await win.setFocus().catch(() => undefined);
}
