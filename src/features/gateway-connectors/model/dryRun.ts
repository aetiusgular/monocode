/**
 * Reading `docker mcp gateway run --profile <id> --dry-run --verbose`, the
 * connector test. The gateway reports each server on stderr: its tool count
 * when it started, or why it could not.
 */

/** What a failure is about, so the UI can offer the right fix. */
export type TestCause =
  "sign-in" | "setup" | "platform" | "docker" | "network" | "other";

export type TestOutcome =
  | { ok: true; tools: number }
  | { ok: false; tools: number; reason: string; cause: TestCause };

const MAX_REASON = 160;

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The first line that reads like an error, without the gateway's bullets. */
function firstErrorLine(lines: readonly string[]): string | null {
  const line = lines.find((entry) =>
    /error|failed|can't|cannot|invalid|denied|not found/i.test(entry),
  );
  if (!line) return null;
  const text = line.replace(/^[\s>*-]+/, "").trim();
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text;
}

/**
 * The test result from the dry run's combined output. `success` is the
 * command's exit status. A server's own tool count wins over warnings
 * elsewhere in the output.
 */
export function parseDryRun(
  output: string,
  server: string,
  success = true,
): TestOutcome {
  const lines = output.split(/\r?\n/).filter((line) => line.trim());
  const own = new RegExp(
    `^\\s*>\\s*${escape(server)}:\\s*\\((\\d+) tools?\\)`,
    "m",
  ).exec(output);
  const listed = /^\s*>\s*(\d+) tools? listed/m.exec(output);
  const tools = Number(own?.[1] ?? listed?.[1] ?? 0);
  const fail = (reason: string, cause: TestCause): TestOutcome => ({
    ok: false,
    tools,
    reason,
    cause,
  });

  if (
    /cannot connect to the docker daemon|docker desktop is not running/i.test(
      output,
    )
  ) {
    return fail("Docker Desktop is not running", "docker");
  }
  if (own && tools > 0) return { ok: true, tools };
  if (/OAuth token not found/i.test(output))
    return fail("Not signed in", "sign-in");
  const missing = /Missing\/invalid config:\s*(.+)/i.exec(output);
  if (missing) {
    const names = missing[1]
      .split(",")
      .map((part) => part.replace(/\((missing|invalid)\)/i, "").trim())
      .filter(Boolean);
    return fail(
      `Missing setting${names.length === 1 ? "" : "s"}: ${names.join(", ")}`,
      "setup",
    );
  }
  if (/no matching manifest for linux\/arm64/i.test(output)) {
    return fail("No build for Apple Silicon", "platform");
  }
  // Docker checks image signatures against Sigstore before a run. A failed
  // key or metadata fetch is the network, not the connector.
  if (
    /verifying docker images|Rekor public keys|TUF remote|TLS handshake timeout|i\/o timeout|connection reset by peer/i.test(
      output,
    )
  ) {
    return fail("Network error while checking the image", "network");
  }
  if (/\bUnauthorized\b/.test(output))
    return fail("Sign-in rejected", "sign-in");
  if (tools > 0 && success) return { ok: true, tools };
  const error = firstErrorLine(lines);
  if (error) return fail(error, "other");
  if (!success) {
    return fail(
      lines[0]?.trim().slice(0, MAX_REASON) || "The test failed",
      "other",
    );
  }
  return fail("No tools", "other");
}
