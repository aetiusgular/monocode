import { ChevronRight, WandSparkles } from "../../../shared/ui/icons";

/** Plus-menu row that opens the per-chat skill switches. */
export function SkillsMenuItem({
  offCount,
  onOpen,
}: {
  /** Skills switched off for this chat. */
  offCount: number;
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
      <WandSparkles className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px]">Skills</span>
        <span className="block truncate whitespace-nowrap text-[11px] leading-4 text-content/45">
          Turn skills off for this chat
        </span>
      </span>
      {offCount > 0 ? (
        <span className="mt-0.5 shrink-0 text-[11px] leading-4 text-content/45">
          {offCount} off
        </span>
      ) : (
        <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-content/40" />
      )}
    </button>
  );
}
