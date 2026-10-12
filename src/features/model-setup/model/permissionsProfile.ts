import { sanitizeModelProvider } from "./modelProvider";

/**
 * A saved permissions profile id read back. A Codex named permissions profile
 * is a config key like a provider id, so it takes the same charset and bound:
 * letters, digits, `.`, `_` and `-`. Anything else is dropped, so a stored
 * value can never carry a path, a URL or a shell word into a launch.
 */
export function sanitizePermissionsProfile(value: unknown): string | undefined {
  return sanitizeModelProvider(value);
}
