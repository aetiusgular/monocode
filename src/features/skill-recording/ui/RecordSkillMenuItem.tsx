import { CircleDot } from "../../../shared/ui/icons";

/** Plus-menu row that opens the "Record a skill" dialog. */
export function RecordSkillMenuItem({
  disabled,
  hint,
  onOpen,
}: {
  disabled: boolean;
  hint: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onOpen}
      className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left text-content hover:bg-content/10 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <CircleDot className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px]">Record a skill</span>
        <span className="block truncate whitespace-nowrap text-[11px] leading-4 text-content/45">
          {hint}
        </span>
      </span>
    </button>
  );
}
