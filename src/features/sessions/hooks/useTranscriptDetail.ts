import { useCallback, useState, useSyncExternalStore } from "react";
import {
  isTranscriptDetail,
  loadTranscriptDetail,
  TRANSCRIPT_DETAIL_CHANGE_EVENT,
  TRANSCRIPT_DETAIL_DEFAULT,
  type TranscriptDetail,
} from "../../settings/model/appearance";

// One copy for every transcript row, read from storage once, so a long
// transcript does not hit localStorage per row on each render.
let current: TranscriptDetail | null = null;
// Rows subscribed now. With none, nothing hears a change, so the copy is
// dropped and the next mount reads storage again (Mac 3.10).
let subscribers = 0;

function read(): TranscriptDetail {
  if (current === null) current = loadTranscriptDetail();
  return current;
}

function subscribe(onChange: () => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    current = isTranscriptDetail(detail) ? detail : loadTranscriptDetail();
    onChange();
  };
  window.addEventListener(TRANSCRIPT_DETAIL_CHANGE_EVENT, listener);
  subscribers += 1;
  return () => {
    window.removeEventListener(TRANSCRIPT_DETAIL_CHANGE_EVENT, listener);
    subscribers -= 1;
    if (subscribers <= 0) {
      subscribers = 0;
      current = null;
    }
  };
}

/** The default transcript detail from Settings, Appearance (#48). */
export function useTranscriptDetail(): TranscriptDetail {
  return useSyncExternalStore(subscribe, read, () => TRANSCRIPT_DETAIL_DEFAULT);
}

/** Whether a turn's folded work starts open. */
export function workStartsOpen(detail: TranscriptDetail): boolean {
  return detail !== "summary";
}

/** Whether a thinking or tool row starts expanded. */
export function rowStartsOpen(detail: TranscriptDetail): boolean {
  return detail === "full";
}

/**
 * A thinking or tool row's open state. It follows the setting, also when the
 * setting changes with the transcript open, until the user opens or closes
 * that row by hand (Mac 3.10).
 */
export function useRowOpen(): [
  boolean,
  (update: (open: boolean) => boolean) => void,
] {
  const startsOpen = rowStartsOpen(useTranscriptDetail());
  const [byHand, setByHand] = useState<boolean | null>(null);
  const toggle = useCallback(
    (update: (open: boolean) => boolean) =>
      setByHand((previous) => update(previous ?? startsOpen)),
    [startsOpen],
  );
  return [byHand ?? startsOpen, toggle];
}

/** For tests: forget the cached value. */
export function resetTranscriptDetailCache(): void {
  current = null;
}
