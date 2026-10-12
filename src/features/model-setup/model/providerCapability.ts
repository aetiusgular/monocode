import type { HarnessId } from "../../sessions/model/session";

/**
 * Harnesses that take a model provider per chat (`modelProvider` on Codex's
 * `thread/start`). A local constant because `capabilities.ts` is read only
 * during the parallel build; session 6 is asked to move it into the table as
 * a `modelProvider` flag.
 */
const TAKES_MODEL_PROVIDER: ReadonlySet<HarnessId> = new Set<HarnessId>([
  "codex",
]);

export function harnessTakesModelProvider(id: HarnessId): boolean {
  return TAKES_MODEL_PROVIDER.has(id);
}
