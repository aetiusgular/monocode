import type { Session } from "../../sessions/model/session";
import type { Locality } from "../../server-locality/model/locality";
import { providerForAccount, findModelProvider } from "./modelProviders";
import { providerLocality } from "./providerLocality";
import { harnessCan } from "../../../integrations/harness/core/capabilities";

export type SessionProviderInput = Pick<Session, "harness"> &
  Partial<Pick<Session, "modelProvider" | "providerAccountId">>;

/**
 * The model provider a Codex session runs on, as far as MonoCode knows:
 * the provider picked for the chat, else the provider the Models page wrote
 * into the chat's Codex account. Undefined means the home's own config
 * decides, which MonoCode does not read (the wrapper script case).
 */
export function sessionModelProvider(
  session: SessionProviderInput,
): string | undefined {
  if (!harnessCan(session.harness, "modelProvider")) return undefined;
  if (session.modelProvider) return session.modelProvider;
  return providerForAccount(session.providerAccountId)?.id;
}

/** Where a session's model route goes. Unknown counts as hosted. */
export function sessionProviderLocality(
  session: SessionProviderInput,
): Locality {
  if (session.harness === "claude") return "hosted";
  if (!harnessCan(session.harness, "modelProvider")) return "unknown";
  return providerLocality(sessionModelProvider(session));
}

/** Label for the composer badge: the provider's name, or undefined. */
export function sessionProviderLabel(
  session: SessionProviderInput,
): string | undefined {
  const id = sessionModelProvider(session);
  if (!id) return undefined;
  return findModelProvider(id)?.label ?? id;
}

/**
 * Whether Auto mode may be offered. Auto hands approvals to Codex's
 * auto-review, which is tested only on OpenAI's models. It stays for a Codex
 * session on OpenAI or on a provider MonoCode does not know, and for every
 * other harness (their Auto is their own). It is hidden once the chat is
 * known to run on another provider.
 */
export function autoModeAllowed(session: SessionProviderInput): boolean {
  if (!harnessCan(session.harness, "modelProvider")) return true;
  const id = sessionModelProvider(session);
  return !id || id === "openai";
}
