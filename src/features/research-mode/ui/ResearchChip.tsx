import { Globe, X } from "../../../shared/ui/icons";

/**
 * Shown above the composer input while research is on for the next message.
 * `canSearch` false means the chat lost its search tools after research was
 * turned on; the message is not sent as research until one is back.
 */
export function ResearchChip({
  canSearch,
  onClear,
}: {
  canSearch: boolean;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 px-3 pt-2" data-research-chip>
      <div
        title={
          canSearch
            ? "The next message is sent as research"
            : "No search tool in this chat. Add one in Settings, Connectors."
        }
        className="flex min-w-0 items-center gap-1.5 rounded-md bg-teal-500/12 py-0.5 pl-1.5 pr-1 text-teal-700 dark:bg-teal-400/10 dark:text-teal-200/90"
      >
        <Globe className="size-3.5 shrink-0" />
        <span className="text-[11px] leading-none">Research</span>
        {canSearch ? null : (
          <span className="text-[10px] leading-none text-content/50">
            No search tool in this chat
          </span>
        )}
        <button
          type="button"
          title="Turn off Research"
          aria-label="Turn off Research"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClear}
          className="grid size-4 shrink-0 place-items-center rounded-full opacity-70 hover:bg-content/15 hover:opacity-100"
        >
          <X className="size-3" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
