import { useEffect, useState } from "react";
import { listHarnessSessions_l1 } from "../../../integrations/harness/core/registry";
import { HARNESS_TITLE } from "../../sessions/model/session";
import {
  Popover,
  type PopoverAnchor,
  type PopoverDismissReason,
} from "../../../shared/ui/Popover";
import {
  pickUpEmpty,
  pickUpError,
  pickUpNote,
  pickUpRows,
  type PickUpRow,
  type PickUpTarget,
} from "../model/pickUp";
import { rowAge } from "../model/sessionImport";
import type { HarnessSessionRow } from "../model/types";

const NOTE = "px-2 pb-0.5 pt-1 text-[11px] leading-4 text-content/45";

type ListState =
  | { status: "loading" }
  | { status: "ready"; rows: HarnessSessionRow[] }
  | { status: "error"; message: string };

/**
 * #45: the sessions the chat's harness recorded for this folder, outside
 * MonoCode or in an earlier chat. Picking one opens a chat bound to it; one
 * already bound opens that chat instead.
 */
export function PickUpSessionPopover({
  anchor,
  target,
  list = listHarnessSessions_l1,
  onDismiss,
}: {
  anchor: PopoverAnchor;
  target: PickUpTarget;
  /** Test seam. */
  list?: typeof listHarnessSessions_l1;
  onDismiss: (reason: PopoverDismissReason | "picked") => void;
}) {
  const { harness, cwd, providerAccountId } = target;
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [picking, setPicking] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    list(harness, { cwd, providerAccountId })
      .then((rows) => {
        if (live) setState({ status: "ready", rows });
      })
      .catch((error: unknown) => {
        if (live)
          setState({ status: "error", message: pickUpError(harness, error) });
      });
    return () => {
      live = false;
    };
  }, [list, harness, cwd, providerAccountId]);

  const pick = (row: PickUpRow) => {
    if (picking) return;
    setPicking(row.id);
    setPickError(null);
    target
      .onPick(row)
      .then(() => onDismiss("picked"))
      .catch((error: unknown) => {
        setPicking(null);
        setPickError(
          error instanceof Error ? error.message : String(error ?? "Failed"),
        );
      });
  };

  const rows =
    state.status === "ready" ? pickUpRows(state.rows, target.bound) : [];
  const name = HARNESS_TITLE[harness];
  return (
    <Popover
      anchor={anchor}
      side="top"
      align="start"
      width={340}
      onDismiss={onDismiss}
      data-composer-plus
      role="dialog"
      aria-label={`Pick up a ${name} session`}
      className="p-1.5"
    >
      <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-content/40">
        {name} sessions in this folder
      </p>
      {state.status === "loading" ? (
        <p className={NOTE} role="status">
          Asking {name}…
        </p>
      ) : state.status === "error" ? (
        <p className={`${NOTE} text-red-300/80`} role="alert">
          {state.message}
        </p>
      ) : rows.length === 0 ? (
        <p className={NOTE}>{pickUpEmpty(harness)}</p>
      ) : (
        <ul
          aria-label={`${name} sessions`}
          className="max-h-[min(320px,45vh)] overflow-y-auto overscroll-contain"
        >
          {rows.map((row) => (
            <li key={row.id} data-pick-up-session={row.id}>
              <button
                type="button"
                disabled={picking !== null}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(row)}
                title={row.id}
                className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left text-content hover:bg-content/10 disabled:cursor-wait disabled:opacity-60"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">
                    {row.title}
                  </span>
                  <span className="block truncate whitespace-nowrap text-[11px] leading-4 text-content/45">
                    {[rowAge(row.updatedAt), row.detail]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="mt-0.5 shrink-0 text-[11px] leading-4 text-content/45">
                  {picking === row.id
                    ? "Opening…"
                    : row.boundTo
                      ? "Open chat"
                      : "Pick up"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {pickError ? (
        <p className={`${NOTE} text-red-300/80`} role="alert">
          {pickError}
        </p>
      ) : null}
      <p className={NOTE}>{pickUpNote(harness)}</p>
    </Popover>
  );
}
