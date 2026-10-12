import type { Locality } from "./locality";

/** The fields an MCP server locality decision may read. */
export type LocalityServer = {
  name: string;
  /** Program a stdio server runs. */
  command?: string;
  args?: readonly string[];
  /** Address of an HTTP server. */
  url?: string;
};

/**
 * Contract for the parallel build, filled by lane 4 (#9): whether an MCP
 * server keeps what it is given on this Mac. Until then every server is
 * "unknown", which callers treat as hosted.
 */
export function serverLocality(_server: LocalityServer): Locality {
  return "unknown";
}
