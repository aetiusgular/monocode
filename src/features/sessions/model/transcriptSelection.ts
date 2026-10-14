export const SELECTABLE_AGENT_RESPONSE_ATTR = "data-selectable-agent-response";

/** Marks the selection menu, so a press on it is not a new selection. */
export const TRANSCRIPT_SELECTION_MENU_ATTR = "data-transcript-selection-menu";

export type TranscriptSelection = {
  text: string;
  rect: DOMRect;
};

export type TranscriptSelectionCandidate = {
  text: string;
  collapsed: boolean;
  anchorResponseId: string | null;
  focusResponseId: string | null;
};

export function validateTranscriptSelection(
  candidate: TranscriptSelectionCandidate,
): string | null {
  const text = candidate.text.trim();
  if (!text || candidate.collapsed) return null;
  if (!candidate.anchorResponseId || !candidate.focusResponseId) return null;
  if (candidate.anchorResponseId !== candidate.focusResponseId) return null;
  return text;
}
