import { sanitizeModelProvider } from "../../../../features/model-setup/model/modelProvider";
import { sanitizePermissionsProfile } from "../../../../features/model-setup/model/permissionsProfile";
import { autoModeAllowed } from "../../../../features/model-setup/model/sessionProvider";
import { providerForAccount } from "../../../../features/model-setup/model/modelProviders";
import { providerLocality } from "../../../../features/model-setup/model/providerLocality";
import {
  reportedRouteLocality,
  type Locality,
} from "../../../../features/server-locality/model/locality";
import type { CodexModelRoute } from "./codexProtocol";

/** The provider and permissions profile a Codex thread is opened with. */
export type CodexThreadIdentity = {
  modelProvider?: string;
  permissionsProfile?: string;
  /**
   * Auto mode hands approvals to Codex's auto-review, tested only on OpenAI
   * models. True when the chat is known to run on another provider: the
   * thread and its turns then send `approvalsReviewer: "user"`, so Auto
   * behaves as Auto-accept edits there.
   */
  autoReviewOff?: boolean;
};

/**
 * The chat's provider and profile, cleaned. An id that fails the charset
 * check is never sent to Codex.
 */
export function codexThreadIdentity(input: {
  modelProvider?: unknown;
  permissionsProfile?: unknown;
  providerAccountId?: unknown;
}): CodexThreadIdentity {
  const modelProvider = sanitizeModelProvider(input.modelProvider);
  const permissionsProfile = sanitizePermissionsProfile(
    input.permissionsProfile,
  );
  const autoReviewOff = !autoModeAllowed({
    harness: "codex",
    modelProvider,
    providerAccountId:
      typeof input.providerAccountId === "string"
        ? input.providerAccountId
        : undefined,
  });
  return {
    ...(modelProvider ? { modelProvider } : {}),
    ...(permissionsProfile ? { permissionsProfile } : {}),
    ...(autoReviewOff ? { autoReviewOff } : {}),
  };
}

/**
 * Part of the live-process reuse key. Both are fixed when the thread opens,
 * so a change to either reopens the thread with the new values.
 */
export function codexThreadIdentityKey(identity: CodexThreadIdentity): string {
  return `${identity.modelProvider ?? ""}\n${identity.permissionsProfile ?? ""}\n${identity.autoReviewOff ? "user-review" : ""}`;
}

/** A standing host rule Codex proposed with a network approval request. */
export type CodexNetworkAmendment = { host: string; action: "allow" | "deny" };

/**
 * The amendment to send when the user picked "Always allow <host>": only an
 * `allow` for that exact host that Codex itself proposed for this request.
 * Anything else returns null, and the caller sends a plain accept. A `deny`
 * amendment is never chosen here.
 */
export function pickCodexNetworkAmendment(
  proposed: readonly CodexNetworkAmendment[] | undefined,
  requested: { host: string; action: string } | undefined,
): { host: string; action: "allow" } | null {
  if (!requested || requested.action !== "allow") return null;
  const match = proposed?.find(
    (item) => item.action === "allow" && item.host === requested.host,
  );
  return match ? { host: match.host, action: "allow" } : null;
}

/**
 * Codex's `CommandExecutionApprovalDecision::ApplyNetworkPolicyAmendment`
 * on the wire: an externally tagged camelCase variant whose struct field
 * keeps its snake_case name.
 */
export function codexNetworkAmendmentDecision(amendment: {
  host: string;
  action: "allow";
}): Record<string, unknown> {
  return {
    applyNetworkPolicyAmendment: {
      network_policy_amendment: {
        host: amendment.host,
        action: amendment.action,
      },
    },
  };
}

/**
 * Where a Codex thread's model route goes: the provider picked for the chat,
 * else the one the Models page wrote for its account, else the route this
 * Codex reports in `config/read` (a wrapper script home). Unknown when none
 * of these says.
 */
export function codexRouteLocality(input: {
  modelProvider?: unknown;
  providerAccountId?: unknown;
  reported?: CodexModelRoute | null;
}): Locality {
  const picked =
    sanitizeModelProvider(input.modelProvider) ??
    providerForAccount(
      typeof input.providerAccountId === "string"
        ? input.providerAccountId
        : undefined,
    )?.id;
  if (picked) return providerLocality(picked);
  return input.reported ? reportedRouteLocality(input.reported) : "unknown";
}

/**
 * Codex's own `web_search` tool searches through the model's service. A local
 * model server has no such service: Ollama answers "ollama cloud is disabled:
 * web search is unavailable" after the turn has run (Mac test 11.15). On a
 * local route the thread is opened with web search off, which Codex 0.161.0
 * honours as the top-level `web_search = "disabled"` (the request's `tools`
 * then has no `web_search`; `tools.web_search = false` and
 * `features.web_search_request = false` leave it in). Hosted and unknown
 * routes keep Codex's own setting.
 */
export function codexWebSearchConfig(
  route: Locality,
): Record<string, string> | undefined {
  return route === "local" ? { web_search: "disabled" } : undefined;
}
