import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";

/**
 * Brings the app window back in front, for example after a sign-in finished
 * in the browser. Does nothing outside the app.
 *
 * The window is unminimized and shown before it is focused: macOS does not
 * bring forward a window that is hidden or minimized (Mac 11.2). Recent
 * macOS can also refuse focus to an app the user is not in. When the window
 * still is not focused, the Dock icon asks for attention once instead.
 */
export async function bringAppToFront(): Promise<void> {
  if (!isTauri()) return;
  const win = getCurrentWindow();
  await win.unminimize().catch(() => undefined);
  await win.show().catch(() => undefined);
  await win.setFocus().catch(() => undefined);
  const focused = await win.isFocused().catch(() => true);
  if (!focused) {
    await win
      .requestUserAttention(UserAttentionType.Informational)
      .catch(() => undefined);
  }
}
