import { describe, expect, it } from "vitest";
import { parseDryRun } from "./dryRun";

// Real output from `docker mcp gateway run --profile <id> --dry-run
// --verbose`, docker mcp v0.44.1 on an Apple Silicon Mac.
const HUGGING_FACE = [
  "> hugging-face: (4 tools) (158 resources)",
  "> 4 tools listed in 1.17s",
].join("\n");

const NOTION_SIGNED_OUT = [
  "Failed to get OAuth token for notion-remote: OAuth token not found for notion-remote. Run 'docker mcp oauth authorize notion-remote' to authenticate",
  '> Can\'t start notion-remote: failed to connect: calling "initialize": sending "initialize": Unauthorized',
  "> 0 tools listed",
].join("\n");

const DOTNET = "> dotnet-types-explorer: (5 tools)";

const GMAIL_MISSING_CONFIG = [
  "Cannot activate profile 'monocode-gmail-mcp'. Validation failed for 1 server(s):",
  "Server 'gmail-mcp':",
  "  Missing/invalid config: email_address (missing)",
].join("\n");

const GMAIL_NO_ARM64 = [
  "warning: pulling docker image yashtekwani/gmail-mcp@sha256:4e1c: Error response from daemon: no matching manifest for linux/arm64/v8 in the manifest list entries",
  "- gmail-mcp: docker: Error response from daemon: No such image: yashtekwani/gmail-mcp@sha256:4e1c",
  "> 0 tools listed",
].join("\n");

describe("parseDryRun", () => {
  it("passes a server that lists its tools", () => {
    expect(parseDryRun(HUGGING_FACE, "hugging-face")).toEqual({
      ok: true,
      tools: 4,
    });
    expect(parseDryRun(DOTNET, "dotnet-types-explorer")).toEqual({
      ok: true,
      tools: 5,
    });
  });

  it("says a sign-in is missing", () => {
    expect(parseDryRun(NOTION_SIGNED_OUT, "notion-remote")).toEqual({
      ok: false,
      tools: 0,
      reason: "Not signed in",
      cause: "sign-in",
    });
    expect(
      parseDryRun(
        '> Can\'t start notion-remote: failed to connect: calling "initialize": sending "initialize": Unauthorized\n> 0 tools listed',
        "notion-remote",
      ),
    ).toMatchObject({
      ok: false,
      reason: "Sign-in rejected",
      cause: "sign-in",
    });
  });

  it("names a missing setting", () => {
    expect(parseDryRun(GMAIL_MISSING_CONFIG, "gmail-mcp", false)).toEqual({
      ok: false,
      tools: 0,
      reason: "Missing setting: email_address",
      cause: "setup",
    });
    expect(
      parseDryRun(
        "  Missing/invalid config: email_address (missing), imap_host (invalid)",
        "gmail-mcp",
        false,
      ),
    ).toMatchObject({ reason: "Missing settings: email_address, imap_host" });
  });

  it("says when an image has no Apple Silicon build", () => {
    expect(parseDryRun(GMAIL_NO_ARM64, "gmail-mcp")).toEqual({
      ok: false,
      tools: 0,
      reason: "No build for Apple Silicon",
      cause: "platform",
    });
  });

  it("calls a failed image signature check a network error", () => {
    // Seen on a first add: Docker could not fetch Sigstore keys.
    expect(
      parseDryRun(
        "- Verifying images [mcp/time]\nverifying docker images: getting Rekor public keys: updating local metadata and targets: error updating to TUF remote mirror: tuf: failed to download 13.root.json",
        "time",
        false,
      ),
    ).toEqual({
      ok: false,
      tools: 0,
      reason: "Network error while checking the image",
      cause: "network",
    });
  });

  it("reports Docker not running as Docker's state", () => {
    expect(
      parseDryRun(
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
        "x",
        false,
      ),
    ).toMatchObject({ ok: false, cause: "docker" });
  });

  it("falls back to the first error line, or No tools", () => {
    expect(
      parseDryRun(
        "starting\n- slack: failed to connect: connection refused\n> 0 tools listed",
        "slack",
      ),
    ).toMatchObject({
      ok: false,
      reason: "slack: failed to connect: connection refused",
      cause: "other",
    });
    expect(parseDryRun("> 0 tools listed", "time")).toMatchObject({
      ok: false,
      reason: "No tools",
    });
    expect(parseDryRun("", "time", false)).toMatchObject({
      ok: false,
      reason: "The test failed",
    });
    const long = `- x: Error: ${"y".repeat(400)}`;
    const outcome = parseDryRun(long, "x");
    expect(!outcome.ok && outcome.reason.length).toBe(160);
  });

  it("trusts the server's own tool count over another server's warning", () => {
    expect(
      parseDryRun(
        "warning: something Unauthorized elsewhere\n> hugging-face: (4 tools)",
        "hugging-face",
      ),
    ).toEqual({ ok: true, tools: 4 });
  });
});
