import { useSyncExternalStore } from "react";
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
  return () =>
    window.removeEventListener(TRANSCRIPT_DETAIL_CHANGE_EVENT, listener);
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

/** For tests: forget the cached value. */
export function resetTranscriptDetailCache(): void {
  current = null;
}
