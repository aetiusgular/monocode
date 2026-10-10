import { useCallback, useRef, useSyncExternalStore } from "react";

let host: HTMLElement | null = null;
const listeners = new Set<() => void>();

function setHost(next: HTMLElement | null) {
  if (host === next) return;
  host = next;
  for (const notify of listeners) notify();
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

/** The element the window's title bar offers the panel's button, if any. */
export function useSessionPanelSlot(): HTMLElement | null {
  return useSyncExternalStore(
    subscribe,
    () => host,
    () => null,
  );
}

/**
 * The place in the window's title bar where the session on show puts the
 * button that opens its panel. The button lives up here, beside the tabs,
 * because anywhere inside the pane it would sit on top of the chat. The slot
 * takes no room until a session fills it.
 */
export function SessionPanelSlot() {
  const own = useRef<HTMLElement | null>(null);
  const ref = useCallback((element: HTMLDivElement | null) => {
    if (element) {
      own.current = element;
      setHost(element);
    } else {
      if (host === own.current) setHost(null);
      own.current = null;
    }
  }, []);
  return (
    <div
      ref={ref}
      data-session-panel-slot
      className="flex shrink-0 items-center px-1.5 empty:hidden"
    />
  );
}
