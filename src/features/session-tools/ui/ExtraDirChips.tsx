import { X } from "../../../shared/ui/icons";
import { FileTypeIcon } from "../../files/ui/FileTypeIcon";
import { extraDirName, pendingExtraDirs } from "../model/extraDirs";
import { useTurnStartSnapshot } from "./useTurnStartSnapshot";

/** The session's extra folders, shown above the composer input. */
export function ExtraDirChips({
  dirs,
  busy,
  onRemove,
}: {
  dirs: string[];
  /** A turn is running; folders added now wait for the next one. */
  busy: boolean;
  onRemove: (dir: string) => void;
}) {
  const pending = pendingExtraDirs(dirs, useTurnStartSnapshot(dirs, busy));
  if (dirs.length === 0) return null;
  return (
    <div
      role="list"
      aria-label="Extra folders"
      className="flex flex-wrap gap-1.5 px-3 pt-2"
    >
      {dirs.map((dir) => {
        const name = extraDirName(dir);
        return (
          <div
            key={dir}
            role="listitem"
            title={dir}
            className="group relative flex min-w-0 items-center gap-1.5 rounded-md bg-content/10 py-0.5 pl-1 pr-1"
          >
            <span className="grid size-5 shrink-0 place-items-center">
              <FileTypeIcon name={name} isDir size={16} />
            </span>
            <span className="min-w-0 max-w-[140px] truncate text-[11px] leading-none text-content/80">
              {name}
            </span>
            {pending.has(dir) ? (
              <span
                title="The agent can use this folder from its next turn"
                className="shrink-0 text-[10px] leading-none text-content/40"
              >
                next turn
              </span>
            ) : null}
            <button
              type="button"
              title="Remove"
              aria-label={`Remove folder ${name}`}
              onClick={(event) => {
                event.stopPropagation();
                onRemove(dir);
              }}
              className="grid size-4 shrink-0 place-items-center rounded-full text-content/40 hover:bg-content/15 hover:text-content"
            >
              <X className="size-3" strokeWidth={2} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
