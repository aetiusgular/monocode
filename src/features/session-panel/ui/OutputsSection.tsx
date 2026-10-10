import { useState } from "react";
import { revealPath } from "../../../platform/tauri/fs";
import { File, FolderOpen } from "../../../shared/ui/icons";
import type { DocumentFile } from "../../file-cards/model/documentFiles";
import { REVEAL_LABEL } from "../../file-cards/ui/FileCard";
import { outputTag } from "../model/sessionResources";
import { EmptyNote, PanelSection } from "./PanelSection";

/** Rows shown before the rest fold behind "+N more". */
export const MAX_OUTPUT_ROWS = 6;

/**
 * Documents the agent wrote in this session. A row opens the file; the button
 * that appears on it shows the file in the file manager.
 */
export function OutputsSection({
  files,
  onOpenFile,
}: {
  files: readonly DocumentFile[];
  onOpenFile: (path: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown =
    showAll || files.length <= MAX_OUTPUT_ROWS
      ? files
      : files.slice(0, MAX_OUTPUT_ROWS);
  const more = files.length - shown.length;
  return (
    <PanelSection title="Outputs">
      {files.length === 0 ? (
        <EmptyNote>
          Nothing yet. Documents the agent writes are listed here.
        </EmptyNote>
      ) : (
        <ul>
          {shown.map((file) => (
            <li key={file.path} className="group relative">
              <button
                type="button"
                data-output={file.path}
                title={`Open ${file.relativePath}`}
                className="flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left hover:bg-content/6 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                onClick={() => onOpenFile(file.path)}
              >
                <File
                  className="size-3.5 shrink-0 text-content/50"
                  strokeWidth={1.75}
                />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-content/90">
                  {file.name}
                </span>
                <span className="shrink-0 text-[11px] text-content/40 group-focus-within:invisible group-hover:invisible">
                  {outputTag(file)}
                </span>
              </button>
              <button
                type="button"
                title={REVEAL_LABEL}
                aria-label={`${REVEAL_LABEL}: ${file.name}`}
                data-output-reveal
                className="absolute right-1 top-1 hidden size-6 place-items-center rounded-md text-content/55 hover:bg-content/10 hover:text-content focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent group-focus-within:grid group-hover:grid"
                onClick={() =>
                  void revealPath(file.path).catch(() => undefined)
                }
              >
                <FolderOpen className="size-3.5" strokeWidth={1.75} />
              </button>
            </li>
          ))}
          {more > 0 ? (
            <li>
              <button
                type="button"
                data-output-more
                className="h-7 rounded-md px-2 text-[11.5px] text-content/50 hover:bg-content/6 hover:text-content focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                onClick={() => setShowAll(true)}
              >
                +{more} more
              </button>
            </li>
          ) : null}
        </ul>
      )}
    </PanelSection>
  );
}
