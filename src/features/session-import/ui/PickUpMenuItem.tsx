import { ChevronRight, Terminal } from "../../../shared/ui/icons";
import { HARNESS_TITLE, type HarnessId } from "../../sessions/model/session";

/** #45: plus-menu row that opens the harness's own sessions for this folder. */
export function PickUpMenuItem({
  harness,
  onOpen,
}: {
  harness: HarnessId;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onOpen}
      className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left text-content hover:bg-content/10"
    >
      <Terminal className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px]">Pick up a session</span>
        <span className="block truncate whitespace-nowrap text-[11px] leading-4 text-content/45">
          Continue a {HARNESS_TITLE[harness]} session from the terminal
        </span>
      </span>
      <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-content/40" />
    </button>
  );
}
