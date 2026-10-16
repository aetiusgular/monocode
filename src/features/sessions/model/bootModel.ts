import {
  mergeModelSettings,
  resolveModel,
  storedModelResolved,
} from "./models";
import type { Session } from "./session";

/**
 * The boot pass after the harness catalogs refresh (Mac finding 5.3, retest
 * 3). A chat's saved model is rewritten only when it resolved to a catalog
 * entry: the same id, or one matched by its native id. When `resolveModel`
 * fell back to the catalog's default, because this catalog does not list
 * the chat's model (the Codex path moved to another home), the chat keeps
 * the model it ran on. Model settings still merge.
 *
 * Before, the pass saved `resolved.id` either way, so every Codex chat took
 * the new catalog's model at the next launch.
 */
export function sessionAfterCatalogRefresh<T extends Session>(session: T): T {
  const resolved = resolveModel(session.harness, session.model);
  const modelSettings = mergeModelSettings(resolved, session.modelSettings);
  const model = storedModelResolved(resolved, session.model)
    ? resolved.id
    : session.model;
  if (model === session.model && sameSettings(modelSettings, session.modelSettings)) {
    return session;
  }
  return { ...session, model, modelSettings };
}

function sameSettings(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}
