import { invoke } from "@tauri-apps/api/core";

/**
 * The folders that still exist as directories. Claude Code validates every
 * `--add-dir` when it starts, so a folder that was deleted or lives on an
 * unplugged drive must not reach its command line. When the check itself
 * cannot run, the list is passed through unchanged.
 */
export async function existingDirs(
  dirs: readonly string[] | undefined,
): Promise<string[]> {
  if (!dirs?.length) return [];
  try {
    // One path per call: the command drops missing paths from its answer and
    // normalizes the rest, so a batched reply cannot be matched back by index.
    const found = await Promise.all(
      dirs.map((dir) =>
        invoke<{ isDir?: boolean }[]>("inspect_paths", { paths: [dir] }),
      ),
    );
    return dirs.filter((_, index) => found[index]?.[0]?.isDir === true);
  } catch {
    return [...dirs];
  }
}
