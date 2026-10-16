import type { HelperTarget } from "../../../integrations/harness/core/helperPrompt";
import type { HarnessId } from "../../sessions/model/session";

/**
 * Security review K2: the target for commit and PR text in a Mono's Changes
 * tab. Since v0.13.0 that tab lists every project the Mono has, not only its
 * own checkout, and each shows the repository's whole staged diff. A route
 * names one chat and skips the owner lookup, so a hosted Mono would write
 * the text for changes a local chat made. A bare harness id makes the text
 * helper find, per project, the chat that owns the checkout (a local one
 * wins), or ask before a diff leaves when none clearly does (F3). In the
 * Mono's own checkout, with no other chat there, the Mono itself owns it.
 */
export function monoChangesTextTarget(mono: {
  harness: HarnessId;
}): HelperTarget {
  return mono.harness;
}
