import { useState } from "react";
import { revealPath } from "../../../platform/tauri/fs";
import { ChevronDown, ChevronRight } from "../../../shared/ui/icons";
import {
  MAX_DOCUMENT_CARDS,
  documentCardWindow,
  type DocumentFile,
} from "../model/documentFiles";
import { FileCard } from "./FileCard";

/** A turn's document cards. Past the cap the rest wait behind "+N more". */
export function FileCardList({
  files,
  onOpenFile,
  onRevealFile = revealPath,
}: {
  files: readonly DocumentFile[];
  onOpenFile: (path: string) => void;
  onRevealFile?: (path: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) return null;
  const { visible, hidden } = documentCardWindow(files, expanded);
  return (
    <div data-file-cards className="flex flex-col gap-2 px-4 pt-1 pb-3">
      <ul
        aria-label="Documents written in this turn"
        className="flex flex-col gap-2"
      >
        {visible.map((file) => (
          <li key={file.path} className="min-w-0">
            <FileCard file={file} onOpen={onOpenFile} onReveal={onRevealFile} />
          </li>
        ))}
      </ul>
      {files.length > MAX_DOCUMENT_CARDS ? (
        <button
          type="button"
          data-file-cards-more
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="flex h-7 items-center gap-1.5 self-start rounded-md px-2 font-sans text-[11px] text-content/45 hover:bg-content/5 hover:text-content/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {expanded ? (
            <ChevronDown className="size-3.5" strokeWidth={1.75} />
          ) : (
            <ChevronRight className="size-3.5" strokeWidth={1.75} />
          )}
          <span>{expanded ? "Show fewer" : `+${hidden} more`}</span>
        </button>
      ) : null}
    </div>
  );
}
