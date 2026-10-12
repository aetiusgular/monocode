import type { Locality } from "../../server-locality/model/locality";

/**
 * Contract for the parallel build, filled by lane 5: whether a model provider
 * id names a server on this Mac. A provider is local when its base URL is a
 * loopback address. OpenRouter and any rented machine are hosted. Until then
 * every provider is "unknown", which callers treat as hosted.
 */
export function providerLocality(_providerId: string | undefined): Locality {
  return "unknown";
}
