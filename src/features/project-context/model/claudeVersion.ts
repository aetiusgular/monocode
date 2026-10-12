import {
  execChild,
  resolveClaudeBinary,
} from "../../../integrations/harness/core/child";

/**
 * The installed Claude Code's version, read once per app run with
 * `claude --version`, the same call the model catalog falls back to. Used to
 * pick the `AGENTS.md` plugin id (#27). Undefined when it cannot be read;
 * callers then leave the setting out.
 */
let cached: Promise<string | undefined> | undefined;

export function claudeCliVersion(): Promise<string | undefined> {
  cached ??= (async () => {
    try {
      const { path } = await resolveClaudeBinary();
      const out = await execChild(path, ["--version"], undefined, "claude");
      return out.trim().slice(0, 200) || undefined;
    } catch {
      return undefined;
    }
  })();
  return cached;
}

/** Test seam, and for after the CLI is updated. */
export function forgetClaudeCliVersion(): void {
  cached = undefined;
}
