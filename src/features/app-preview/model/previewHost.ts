/**
 * #37: what the session panel needs from the app, without new props through
 * the pane tree: open a chat's preview in the editor area. The app sets it
 * once; until then the button is not shown.
 */
export type PreviewHost = {
  openPane(sessionId: string): void;
};

let host: PreviewHost | null = null;
const listeners = new Set<() => void>();

export function setPreviewHost(next: PreviewHost | null): void {
  host = next;
  for (const listener of [...listeners]) listener();
}

export function previewHost(): PreviewHost | null {
  return host;
}

export function subscribePreviewHost(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
