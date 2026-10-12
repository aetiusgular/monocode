import { useState } from "react";
import { IS_MAC, IS_WIN } from "../../../platform/tauri/platform";
import { File } from "../../../shared/ui/icons";
import type { DocumentFile } from "../model/documentFiles";
import { saveCopyOf, type SaveCopyResult } from "../model/saveCopy";

export const REVEAL_LABEL = IS_MAC
  ? "Reveal in Finder"
  : IS_WIN
    ? "Reveal in File Explorer"
    : "Open Containing Folder";

/** One document the agent wrote: what it is, where it is, and how to get it. */
export function FileCard({
  file,
  onOpen,
  onReveal,
  onSave = saveCopyOf,
}: {
  file: DocumentFile;
  onOpen: (path: string) => void;
  onReveal: (path: string) => Promise<void>;
  onSave?: (path: string) => Promise<SaveCopyResult>;
}) {
  const [revealFailed, setRevealFailed] = useState(false);
  const [saved, setSaved] = useState<SaveCopyResult | null>(null);
  const [saving, setSaving] = useState(false);
  const save = () => {
    if (saving) return;
    setSaving(true);
    setSaved(null);
    void onSave(file.path)
      .catch(
        (cause: unknown): SaveCopyResult => ({
          status: "error",
          message: String(cause),
        }),
      )
      .then((result) => {
        setSaving(false);
        setSaved(result.status === "cancelled" ? null : result);
      });
  };
  const reveal = () => {
    setRevealFailed(false);
    void onReveal(file.path).catch(() => setRevealFailed(true));
  };
  return (
    <div
      data-file-card={file.path}
      className="flex w-full max-w-lg min-w-0 items-center gap-3 rounded-xl border border-content/10 bg-content/5 px-3 py-2.5 font-sans"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-content/8 text-content/55">
        <File className="size-4" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span
            title={file.name}
            className="truncate text-[13px] font-medium text-content"
          >
            {file.name}
          </span>
          <span className="shrink-0 text-[11px] text-content/45">
            {file.typeLabel}
          </span>
        </div>
        {saved?.status === "saved" ? (
          <div
            role="status"
            title={saved.path}
            className="truncate text-[11px] text-content/50"
          >
            Saved a copy to {saved.path}
          </div>
        ) : saved?.status === "error" ? (
          <div
            role="status"
            title={saved.message}
            className="truncate text-[11px] text-content/50"
          >
            Couldn’t save a copy: {saved.message}
          </div>
        ) : revealFailed ? (
          <div role="status" className="truncate text-[11px] text-content/50">
            Couldn’t reveal this file
          </div>
        ) : (
          <div
            title={file.path}
            className="truncate font-mono text-[11px] text-content/45"
          >
            {file.relativePath}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          title={REVEAL_LABEL}
          aria-label={`${REVEAL_LABEL}: ${file.name}`}
          onClick={reveal}
          className="h-7 rounded-md px-2.5 text-[11px] text-content/50 hover:bg-content/8 hover:text-content focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          Reveal
        </button>
        <button
          type="button"
          title="Save a copy to a folder you choose"
          aria-label={`Save a copy of ${file.name}`}
          onClick={save}
          disabled={saving}
          className="h-7 rounded-md px-2.5 text-[11px] text-content/50 hover:bg-content/8 hover:text-content disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          title="Open in the editor"
          aria-label={`Open ${file.name}`}
          onClick={() => onOpen(file.path)}
          className="h-7 rounded-md border border-content/12 bg-content/8 px-2.5 text-[11px] font-medium text-content/75 hover:bg-content/12 hover:text-content focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          Open
        </button>
      </div>
    </div>
  );
}
