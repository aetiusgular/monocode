import { convertFileSrc, invoke } from "@tauri-apps/api/core";

/** The URI scheme the Rust side registers (`src-tauri/src/sandbox_frame.rs`). */
export const SANDBOX_FRAME_SCHEME = "mcpreview";

/** The same ceiling the Rust store enforces, checked here first. */
export const MAX_FRAME_DOCUMENT_BYTES = 10 * 1024 * 1024;

const TOKEN = /^[0-9a-f]{32}$/;

/** Hold a document in the app's frame store; returns the token that names it. */
export async function putFrameDocument(html: string): Promise<string> {
  const token = await invoke<string>("sandbox_frame_put", { html });
  if (!TOKEN.test(token)) throw new Error("The preview store returned a bad token.");
  return token;
}

/** Drop a document once nothing shows it. Never throws. */
export async function releaseFrameDocument(token: string): Promise<void> {
  if (!TOKEN.test(token)) return;
  try {
    await invoke("sandbox_frame_release", { token });
  } catch {
    // The store bounds itself; a lost release only keeps a document longer.
  }
}

/**
 * The frame URL for a token: `mcpreview://localhost/<token>` on macOS and
 * Linux, `http://mcpreview.localhost/<token>` on Windows.
 */
export function frameUrlForToken(token: string): string {
  if (!TOKEN.test(token)) throw new Error("Not a frame token.");
  return convertFileSrc(token, SANDBOX_FRAME_SCHEME);
}
