import { findModelProvider } from "../../model-setup/model/modelProviders";
import { isLoopbackUrl } from "../../model-setup/model/loopback";
import {
  selectedProviderAccountId,
  supportsProviderAccounts,
} from "../../providers/model/providerAccounts";
import type { Locality, LocalitySession } from "./locality";
import type { ReportedModelRoute } from "./sessionServers";

/**
 * Where a route a harness reported goes, apart from `locality.ts` so the
 * gateway's local default (`localDefault.ts`) can read it without an import
 * cycle through `sessionGateway.ts`.
 */

/** The account a session's turns run on, as a turn and the Connectors list resolve it. */
export function localityAccount(session: LocalitySession): string | undefined {
  if (session.providerAccountId) return session.providerAccountId;
  if (!supportsProviderAccounts(session.harness)) return undefined;
  try {
    return selectedProviderAccountId(session.harness, session.cwd);
  } catch {
    return undefined;
  }
}

/**
 * True for an Ollama model name that runs on ollama.com through the local
 * Ollama (`gpt-oss:120b-cloud`, `qwen3-coder:480b-cloud`, `x:cloud`).
 */
export function isRelayedCloudModel(model: string | undefined): boolean {
  return !!model && /[-:]cloud$/i.test(model.trim());
}

/**
 * Where a route the harness reported goes (Mac finding 5.6). The provider's
 * base URL from the harness's own configuration is parsed with the URL
 * parser: loopback (`localhost`, 127.0.0.0/8, `::1`, no user name or
 * password) is local, any other address is hosted. A provider the Models page
 * set up as rented or OpenRouter is hosted whatever its URL. `openai` with no
 * base URL is hosted. Anything else is unknown. A model whose name ends in
 * `-cloud` or `:cloud` is an Ollama cloud model, which a local Ollama relays
 * to ollama.com: hosted.
 */
export function reportedRouteLocality(route: ReportedModelRoute): Locality {
  if (isRelayedCloudModel(route.model)) return "hosted";
  const known = findModelProvider(route.provider)?.entry?.kind;
  if (known === "rented" || known === "openrouter") return "hosted";
  const baseUrl = Object.prototype.hasOwnProperty.call(
    route.baseUrls,
    route.provider,
  )
    ? route.baseUrls[route.provider]
    : undefined;
  if (baseUrl) return isLoopbackUrl(baseUrl) ? "local" : "hosted";
  if (route.provider === "openai") return "hosted";
  return "unknown";
}
