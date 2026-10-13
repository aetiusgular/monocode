import { ask } from "@tauri-apps/plugin-dialog";
import {
  HARNESS_TITLE,
  type HarnessId,
} from "../../../features/sessions/model/session";
import { isHarnessAvailable } from "./availability";
import type { PrContent } from "../../../features/source-control/model/gitText";
import {
  generateHarnessCommitMessage,
  generateHarnessPrContent,
  warmupHarnessText,
} from "./registry";
import {
  recordReviewConsent,
  reviewConsented,
} from "../../../features/code-review/model/reviewConsent";
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

export const UNOWNED_REFUSED =
  "Not sent. No chat you have used works in this folder, and you chose to keep the changes on this computer.";

/**
 * F6 covers a checkout an open chat owns. With none, the helper falls back to
 * a harness by id, whose model is hosted or not known to be local, so the
 * diff would leave the computer with no chat to say so (security review,
 * finding F3; corner case 7). Ask once per project and harness. The answer is
 * kept beside code review's, under its own key, so neither covers the other.
 */
export async function confirmUnownedHelper(
  harness: HarnessId,
  cwd: string,
  what: string,
): Promise<boolean> {
  const key = `helper:${harness}:${cwd}`;
  if (reviewConsented(key)) return true;
  // A native dialog: whether `window.confirm` shows anything in the macOS
  // webview was never seen (Mac test 10.2). Any failure counts as no.
  let ok = false;
  try {
    ok = await ask(
      `No chat you have used works in this folder, so ${what} would be written by ${HARNESS_TITLE[harness] ?? harness}, which is hosted or not known to be local. Your changes would leave this computer.\n\nA yes is kept for this project and this harness.`,
      {
        title: "Send the changes?",
        kind: "warning",
        okLabel: "Send them",
        cancelLabel: "Keep them here",
      },
    );
  } catch {
    ok = false;
  }
  if (ok) recordReviewConsent(key);
  return ok;
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
  const harness = pickTextHarness(preferred);
  return confirmUnownedHelper(harness, cwd, "a commit message").then((ok) => {
    if (!ok) throw new Error(UNOWNED_REFUSED);
    return generateHarnessCommitMessage(harness, cwd, signal, paths);
  });
}

export function generatePrContent(
  cwd: string,
  preferred?: HelperTarget,
): Promise<(PrContent & { base: string; head: string }) | null> {
  if (isHelperRoute(preferred)) return helperPrContent(preferred, cwd);
  const harness = pickTextHarness(preferred);
  // Declined: the caller falls back to the commit range, as with no model.
  return confirmUnownedHelper(harness, cwd, "the PR text").then((ok) =>
    ok ? generateHarnessPrContent(harness, cwd) : null,
  );
}
