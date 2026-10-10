import { Globe } from "../../../shared/ui/icons";

/** Composer pill showing that this chat has connectors switched off. */
export function ConnectorsBadge({
  offCount,
  pending,
  onClick,
}: {
  offCount: number;
  /** Changed while a turn is running; takes effect on the next one. */
  pending: boolean;
  onClick: () => void;
}) {
  const summary = `${offCount} ${offCount === 1 ? "connector" : "connectors"} switched off for this chat`;
  const label = pending ? `${summary}, from the next turn` : summary;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-haspopup="dialog"
      data-connectors-badge
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="flex h-6.5 shrink-0 items-center gap-1 rounded-md bg-content/5 px-1.5 text-[11px] text-content/70 hover:bg-content/10 hover:text-content"
    >
      <Globe className="size-3.5" />
      <span>{offCount} off</span>
    </button>
  );
}
