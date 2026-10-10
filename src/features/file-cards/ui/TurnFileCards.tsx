import { memo, useEffect, useMemo, useState } from "react";
import { statFiles } from "../../../platform/tauri/fs";
import type { Block } from "../../sessions/model/session";
import {
  collectTurnDocuments,
  type DocumentFile,
} from "../model/documentFiles";
import { FileCardList } from "./FileCardList";

const NONE: ReadonlySet<string> = new Set();

/**
 * Cards for the documents one turn wrote, under that turn's reply. A live turn
 * shows only the writes that have already completed.
 */
export const TurnFileCards = memo(function TurnFileCards({
  blocks,
  cwd,
  live,
  onOpenFile,
}: {
  blocks: readonly Block[];
  cwd?: string;
  live: boolean;
  onOpenFile: (path: string) => void;
}) {
  const files = useMemo(
    () => collectTurnDocuments(blocks, { cwd, live }),
    [blocks, cwd, live],
  );
  const present = useFilesOnDisk(files, live);
  return <FileCardList files={present} onOpenFile={onOpenFile} />;
});

/**
 * Drops documents that are no longer on disk. The transcript cannot always
 * tell a deletion from a write (Codex reports both as an edit), and a file
 * can be removed after the turn that wrote it. Cards show at once and a
 * missing file's card is withdrawn when the check returns; if the check
 * itself fails, every card stays.
 */
export function useFilesOnDisk(
  files: readonly DocumentFile[],
  live: boolean,
): readonly DocumentFile[] {
  const [missing, setMissing] = useState(NONE);
  const signature = files.map((file) => file.path).join("\n");
  useEffect(() => {
    if (!signature) return;
    let stale = false;
    void statFiles(signature.split("\n"))
      .then((stats) => {
        if (stale) return;
        const gone = stats
          .filter((entry) => entry.mtimeMs == null)
          .map((entry) => entry.path);
        setMissing((previous) =>
          gone.length === previous.size &&
          gone.every((path) => previous.has(path))
            ? previous
            : new Set(gone),
        );
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
    // Settling re-checks: a file written early in a turn may be gone by its end.
  }, [signature, live]);
  return useMemo(
    () =>
      missing.size > 0
        ? files.filter((file) => !missing.has(file.path))
        : files,
    [files, missing],
  );
}
