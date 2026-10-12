import type { Locality } from "../../server-locality/model/locality";
import { findModelProvider } from "./modelProviders";
import { isLoopbackUrl } from "./loopback";

/**
 * Contract for the parallel build, filled by lane 5: whether a model provider
 * id names a server on this Mac.
 *
 * - A provider you set up on the Models page is local when its base URL
 *   parses to a loopback host (`localhost`, 127.0.0.0/8, `::1`), and hosted
 *   otherwise. OpenRouter is hosted. A rented machine is hosted even when it
 *   is reached through an SSH tunnel on loopback: the URL alone cannot tell,
 *   so the setup screen records its kind as "rented".
 * - Codex's built-in `openai` is hosted. Its built-in `ollama` and
 *   `lmstudio` point at loopback and are local.
 * - No id, or an id nobody set up: "unknown", which callers treat as hosted.
 *   A Codex session with no provider runs on whatever its home's
 *   `config.toml` names, which MonoCode does not read.
 */
export function providerLocality(providerId: string | undefined): Locality {
  const provider = findModelProvider(providerId);
  if (!provider) return "unknown";
  if (provider.id === "openai") return "hosted";
  // A tunnel to a rented GPU listens on loopback, so its kind decides.
  if (
    provider.entry?.kind === "openrouter" ||
    provider.entry?.kind === "rented"
  )
    return "hosted";
  return isLoopbackUrl(provider.baseUrl) ? "local" : "hosted";
}
