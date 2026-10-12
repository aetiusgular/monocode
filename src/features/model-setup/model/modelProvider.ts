/** Longest provider id kept. Codex provider ids are config keys. */
export const MAX_MODEL_PROVIDER_LENGTH = 64;

/**
 * A saved provider id read back: letters, digits, `.`, `_` and `-` only,
 * bounded in length. Anything else is dropped, so a stored value can never
 * carry a path, a URL or a shell word into a launch.
 */
export function sanitizeModelProvider(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (!id || id.length > MAX_MODEL_PROVIDER_LENGTH) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return undefined;
  return id;
}
