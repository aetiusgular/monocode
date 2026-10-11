import { ChevronRight, Wrench } from "../../../shared/ui/icons";

/** Plus-menu row that opens the per-chat tool rules. */
export function ToolAccessMenuItem({
  ruleCount,
  onOpen,
}: {
  /** Rules in effect for this chat. */
  ruleCount: number;
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
      <Wrench className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px]">Tool access</span>
        <span className="block truncate whitespace-nowrap text-[11px] leading-4 text-content/45">
          Allow or block tools in this chat
        </span>
      </span>
      {ruleCount > 0 ? (
        <span className="mt-0.5 shrink-0 text-[11px] leading-4 text-content/45">
          {ruleCount} {ruleCount === 1 ? "rule" : "rules"}
        </span>
      ) : (
        <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-content/40" />
      )}
    </button>
  );
}
