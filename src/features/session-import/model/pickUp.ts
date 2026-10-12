import type { HarnessId } from "../../sessions/model/session";
import { HARNESS_TITLE } from "../../sessions/model/session";
import { harnessCan } from "../../../integrations/harness/core/capabilities";
import type { HarnessSessionRow } from "./types";

/** What the composer needs to offer picking up a session. */
export type PickUpTarget = {
  harness: HarnessId;
  /** The folder the chat runs in: its worktree when it has one. */
  cwd: string;
  providerAccountId?: string;
  /** Harness session ids already bound to a MonoCode chat, to that chat's id. */
  bound: ReadonlyMap<string, string>;
  /** Opens the row: the chat already bound to it, or a new one. */
  onPick: (row: HarnessSessionRow) => Promise<void>;
};

/** Whether the harness keeps sessions MonoCode can list, from the capability table. */
export function harnessOffersPickUp(harness: HarnessId): boolean {
  return harnessCan(harness, "listSessions") !== "none";
}

/** Whether a listed session's earlier turns come into the chat. */
export function pickUpImportsTurns(harness: HarnessId): boolean {
  return harnessCan(harness, "listSessions") === "native";
}

export type PickUpRow = HarnessSessionRow & {
  /** The MonoCode chat this session is already bound to. */
  boundTo?: string;
};

export function pickUpRows(
  rows: readonly HarnessSessionRow[],
  bound: ReadonlyMap<string, string>,
): PickUpRow[] {
  return rows.map((row) => {
    const boundTo = bound.get(row.id);
    return boundTo ? { ...row, boundTo } : row;
  });
}

/** The line under the list, saying what picking up does on this harness. */
export function pickUpNote(harness: HarnessId): string {
  const name = HARNESS_TITLE[harness];
  const turns = pickUpImportsTurns(harness)
    ? "Earlier turns are copied in as text."
    : `Earlier turns stay with ${name} and are not shown.`;
  return `${turns} Close the session in the terminal first: two programs writing one session can damage it.`;
}

/** The message when the list is empty. */
export function pickUpEmpty(harness: HarnessId): string {
  return `No ${HARNESS_TITLE[harness]} sessions recorded in this folder.`;
}

/** A failed list or pick, as one line. */
export function pickUpError(harness: HarnessId, error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error");
  const line = message.replace(/\s+/g, " ").trim().slice(0, 300);
  return `${HARNESS_TITLE[harness]} could not list its sessions: ${line || "unknown error"}`;
}
