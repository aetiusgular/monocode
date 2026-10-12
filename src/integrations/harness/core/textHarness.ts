import type { HarnessId } from "../../../features/sessions/model/session";
import { isHarnessAvailable } from "./availability";
import type { PrContent } from "../../../features/source-control/model/gitText";
import {
  generateHarnessCommitMessage,
  generateHarnessPrContent,
  warmupHarnessText,
} from "./registry";
import {
  helperCommitMessage,
  helperPrContent,
  isHelperRoute,
  type HelperTarget,
} from "./helperPrompt";

const TEXT_HARNESSES: HarnessId[] = [
  "claude",
  "cursor",
  "codex",
  "grok",
  "opencode",
];

/**
 * Pick the harness used for titles, commit messages, and PR text.
 * A session route always answers with that session's own harness (F6).
 */
export function pickTextHarness(preferred?: HelperTarget): HarnessId {
  if (isHelperRoute(preferred)) return preferred.harness;
  const ordered =
    preferred && TEXT_HARNESSES.includes(preferred)
      ? [preferred, ...TEXT_HARNESSES.filter((id) => id !== preferred)]
      : TEXT_HARNESSES;
  for (const id of ordered) {
    if (isHarnessAvailable(id)) return id;
  }
  return preferred && TEXT_HARNESSES.includes(preferred) ? preferred : "cursor";
}

export function warmupText(
  cwd: string,
  preferred?: HelperTarget,
): Promise<void> {
  return warmupHarnessText(pickTextHarness(preferred), cwd);
}

export function generateCommitMessage(
  cwd: string,
  preferred?: HelperTarget,
  signal?: AbortSignal,
  paths?: readonly string[],
): Promise<string> {
  if (isHelperRoute(preferred)) {
    return helperCommitMessage(preferred, cwd, signal, paths);
  }
  return generateHarnessCommitMessage(pickTextHarness(preferred), cwd, signal, paths);
}

export function generatePrContent(
  cwd: string,
  preferred?: HelperTarget,
): Promise<(PrContent & { base: string; head: string }) | null> {
  if (isHelperRoute(preferred)) return helperPrContent(preferred, cwd);
  return generateHarnessPrContent(pickTextHarness(preferred), cwd);
}
