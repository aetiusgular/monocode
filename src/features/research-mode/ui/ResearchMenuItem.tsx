import { Check, ChevronRight, Globe } from "../../../shared/ui/icons";
import type { ResearchMenuState } from "../model/visibility";

/**
 * Plus-menu row for research mode. With no search tool in the chat it turns
 * nothing on and opens Settings, Connectors instead.
 */
export function ResearchMenuItem({
  state,
  active,
  onToggle,
  onOpenConnectors,
}: {
  state: Exclude<ResearchMenuState, "hidden">;
  active: boolean;
  onToggle: () => void;
  onOpenConnectors: () => void;
}) {
  if (state === "no-search") {
    return (
      <button
        type="button"
        data-research-menu="no-search"
        title="Add a search connector in Settings, Connectors"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onOpenConnectors}
        className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left text-content hover:bg-content/10"
      >
        <Globe className="mt-0.5 size-4 shrink-0 text-content/35" />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] text-content/60">Research</span>
          <span className="block truncate whitespace-nowrap text-[11px] leading-4 text-content/45">
            No search tool in this chat
          </span>
        </span>
        <span className="mt-0.5 flex shrink-0 items-center gap-0.5 text-[11px] leading-4 text-content/50">
          Connectors
          <ChevronRight className="size-3.5" />
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-pressed={active}
      data-research-menu="ready"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
      className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left text-content hover:bg-content/10"
    >
      <Globe className="mt-0.5 size-4 shrink-0 text-teal-300/80" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px]">Research</span>
        <span className="block truncate whitespace-nowrap text-[11px] leading-4 text-content/45">
          Search the web and write a cited report
        </span>
      </span>
      {active ? (
        <Check className="mt-0.5 size-3.5 shrink-0 text-teal-300/80" />
      ) : null}
    </button>
  );
}
