import { pickFolders } from "../../../platform/tauri/fs";
import { FolderPlus } from "../../../shared/ui/icons";

/** Plus-menu row that opens the system folder picker. */
export function AddFolderMenuItem({
  onOpen,
  onPicked,
}: {
  /** The picker is about to open; close the menu. */
  onOpen: () => void;
  /** Folders chosen, empty when the picker was cancelled. */
  onPicked: (dirs: string[]) => void;
}) {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        onOpen();
        void pickFolders("Add folders").then(onPicked, () => onPicked([]));
      }}
      className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left text-content hover:bg-content/10"
    >
      <FolderPlus className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">
        <span className="block text-[13px]">Add folder</span>
        <span className="block truncate whitespace-nowrap text-[11px] leading-4 text-content/45">
          Give the agent another folder to work in
        </span>
      </span>
    </button>
  );
}
