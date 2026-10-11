/** The two halves of the Connectors page. */
export type ConnectorsTab = "yours" | "discover";

/** App listens for this and opens Settings on the Connectors page. */
export const OPEN_CONNECTORS_EVENT = "monocode:open-connectors";

let requested: ConnectorsTab | null = null;
const tabListeners = new Set<(tab: ConnectorsTab) => void>();

/** Opens the Connectors page on one tab, from anywhere in the app. */
export function openConnectorsPage(tab: ConnectorsTab): void {
  requested = tab;
  for (const listener of tabListeners) listener(tab);
  window.dispatchEvent(new Event(OPEN_CONNECTORS_EVENT));
}

/** The tab the page was last opened on, once. */
export function takeRequestedConnectorsTab(): ConnectorsTab | null {
  const tab = requested;
  requested = null;
  return tab;
}

/** For a page that is already open when it is asked to show a tab. */
export function onConnectorsTabRequest(
  listener: (tab: ConnectorsTab) => void,
): () => void {
  tabListeners.add(listener);
  return () => {
    tabListeners.delete(listener);
  };
}
