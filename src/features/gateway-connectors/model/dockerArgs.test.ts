import { describe, expect, it } from "vitest";
import {
  catalogPullArgs,
  catalogServerRef,
  catalogShowArgs,
  connectorProfileId,
  connectorProfileName,
  gatewayDryRunArgs,
  gatewayRunArgs,
  isAllowedDockerMcpCall,
  isConfigKey,
  MAX_SECRET_BYTES,
  oauthAuthorizeArgs,
  oauthListArgs,
  oauthRevokeArgs,
  profileConfigDelArgs,
  profileConfigGetArgs,
  profileConfigSetArgs,
  profileCreateArgs,
  profileListArgs,
  profileRemoveArgs,
  profileServerAddArgs,
  profileServerRemoveArgs,
  profileShowArgs,
  secretListArgs,
  secretRemoveArgs,
  secretSetArgs,
  versionArgs,
} from "./dockerArgs";

describe("docker mcp argument builders", () => {
  it("build only shapes the app allows", () => {
    const calls: string[][] = [
      versionArgs(),
      catalogShowArgs(),
      catalogShowArgs("monocode/extra"),
      catalogPullArgs(),
      profileListArgs(),
      profileCreateArgs({
        name: connectorProfileName("vercel-remote"),
        id: connectorProfileId("vercel-remote"),
        servers: [catalogServerRef("vercel-remote", "monocode/extra")],
      }),
      profileShowArgs("research"),
      profileCreateArgs({
        name: connectorProfileName("notion-remote"),
        id: connectorProfileId("notion-remote"),
        servers: [catalogServerRef("notion-remote")],
      }),
      profileRemoveArgs("monocode_github"),
      profileServerAddArgs("monocode_github", catalogServerRef("github")),
      profileServerRemoveArgs("monocode_github", "github"),
      secretListArgs(),
      secretRemoveArgs("github.personal_access_token"),
      oauthListArgs(),
      oauthAuthorizeArgs("notion-remote"),
      oauthRevokeArgs("notion-remote"),
      profileConfigSetArgs("monocode_gmail_mcp", {
        "gmail-mcp.email_address": "test@example.com",
      }),
      profileConfigGetArgs("monocode_gmail_mcp"),
      profileConfigDelArgs("monocode_gmail_mcp", "gmail-mcp.email_address"),
      gatewayDryRunArgs("monocode_hugging_face"),
    ];
    for (const args of calls) {
      expect(isAllowedDockerMcpCall(args), args.join(" ")).toBe(true);
    }
    expect(
      isAllowedDockerMcpCall(
        secretSetArgs("github.personal_access_token"),
        "ghp_x",
      ),
    ).toBe(true);
  });

  it("build the exact command lines", () => {
    expect(catalogShowArgs()).toEqual([
      "mcp",
      "catalog",
      "show",
      "mcp/docker-mcp-catalog",
      "--format",
      "json",
    ]);
    expect(
      profileCreateArgs({
        name: "monocode-hugging-face",
        id: "monocode_hugging_face",
        servers: ["catalog://mcp/docker-mcp-catalog/hugging-face"],
      }),
    ).toEqual([
      "mcp",
      "profile",
      "create",
      "--name",
      "monocode-hugging-face",
      "--id",
      "monocode_hugging_face",
      "--server",
      "catalog://mcp/docker-mcp-catalog/hugging-face",
    ]);
    expect(oauthAuthorizeArgs("linear")).toEqual([
      "mcp",
      "oauth",
      "authorize",
      "linear",
      "--open-browser",
    ]);
    expect(gatewayRunArgs("monocode_linear")).toEqual([
      "mcp",
      "gateway",
      "run",
      "--profile",
      "monocode_linear",
    ]);
  });

  it("derive MonoCode's profile id from the server name", () => {
    expect(connectorProfileId("hugging-face")).toBe("monocode_hugging_face");
    expect(connectorProfileId("exa.remote")).toBe("monocode_exa_remote");
    expect(connectorProfileId("x".repeat(100))).toHaveLength(64);
  });

  it("refuse values outside the patterns", () => {
    expect(() => profileShowArgs("Research")).toThrow();
    expect(() => profileRemoveArgs("research")).toThrow();
    expect(() => profileRemoveArgs("monocode_")).toThrow();
    expect(() => catalogServerRef("-flag")).toThrow();
    expect(() => catalogServerRef("a b")).toThrow();
    expect(() =>
      catalogServerRef("x", "other/catalog" as "monocode/extra"),
    ).toThrow();
    expect(catalogServerRef("vercel-remote", "monocode/extra")).toBe(
      "catalog://monocode/extra/vercel-remote",
    );
    expect(() => secretSetArgs("token=abc")).toThrow();
    expect(() => secretSetArgs("a/b")).toThrow();
    expect(() => oauthAuthorizeArgs("--help")).toThrow();
    expect(() =>
      profileCreateArgs({
        name: "monocode-x",
        id: "monocode_x",
        servers: ["docker.io/mcp/github"],
      }),
    ).toThrow();
    expect(() =>
      profileCreateArgs({ name: "monocode-x", id: "monocode_x", servers: [] }),
    ).toThrow();
  });
});

describe("isAllowedDockerMcpCall", () => {
  it("refuses everything else, as the app does", () => {
    for (const args of [
      [],
      ["ps"],
      ["mcp"],
      ["mcp", "gateway", "run", "--profile", "monocode_x"],
      ["mcp", "catalog", "show", "other/catalog", "--format", "json"],
      ["mcp", "catalog", "pull", "monocode/extra"],
      [
        "mcp",
        "profile",
        "create",
        "--name",
        "x",
        "--id",
        "monocode_x",
        "--server",
        "catalog://other/catalog/x",
      ],
      ["mcp", "profile", "remove", "research"],
      ["mcp", "profile", "show", "../x", "--format", "json"],
      ["mcp", "secret", "set", "token", "value"],
      ["mcp", "secret", "set", "token=value"],
      ["mcp", "oauth", "authorize", "linear"],
      ["mcp", "profile", "create", "--name", "x", "--id", "monocode_x"],
      [
        "mcp",
        "profile",
        "server",
        "add",
        "monocode_x",
        "--server",
        "file:///etc/passwd",
      ],
    ]) {
      expect(isAllowedDockerMcpCall(args), args.join(" ")).toBe(false);
    }
  });

  it("takes stdin only for secret set, and requires it there", () => {
    const set = secretSetArgs("exa.api_key");
    expect(isAllowedDockerMcpCall(set)).toBe(false);
    expect(isAllowedDockerMcpCall(set, "")).toBe(false);
    expect(isAllowedDockerMcpCall(set, "x".repeat(MAX_SECRET_BYTES + 1))).toBe(
      false,
    );
    expect(isAllowedDockerMcpCall(secretListArgs(), "value")).toBe(false);
  });
});

describe("config and test builders", () => {
  it("build the verified command lines", () => {
    expect(
      profileConfigSetArgs("monocode_gmail_mcp", {
        "gmail-mcp.email_address": "test@example.com",
        "gmail-mcp.imap_host": "imap.gmail.com",
      }),
    ).toEqual([
      "mcp",
      "profile",
      "config",
      "monocode_gmail_mcp",
      "--set",
      "gmail-mcp.email_address=test@example.com",
      "--set",
      "gmail-mcp.imap_host=imap.gmail.com",
    ]);
    expect(profileConfigGetArgs("monocode_gmail_mcp")).toEqual([
      "mcp",
      "profile",
      "config",
      "monocode_gmail_mcp",
      "--get-all",
      "--format",
      "json",
    ]);
    expect(
      profileConfigDelArgs("monocode_gmail_mcp", "gmail-mcp.email_address"),
    ).toEqual([
      "mcp",
      "profile",
      "config",
      "monocode_gmail_mcp",
      "--del",
      "gmail-mcp.email_address",
    ]);
    expect(gatewayDryRunArgs("monocode_hugging_face")).toEqual([
      "mcp",
      "gateway",
      "run",
      "--profile",
      "monocode_hugging_face",
      "--dry-run",
      "--verbose",
    ]);
  });

  it("refuse bad keys, values and secret properties", () => {
    expect(isConfigKey("gmail-mcp.email_address")).toBe(true);
    expect(isConfigKey("email_address")).toBe(false);
    expect(isConfigKey("gmail-mcp.email-address")).toBe(false);
    expect(isConfigKey("x.api_token")).toBe(false);
    const set = (values: Record<string, string>, secrets?: string[]) => () =>
      profileConfigSetArgs("monocode_gmail_mcp", values, secrets);
    expect(set({})).toThrow();
    expect(set({ "gmail-mcp.email_address": "a\nb" })).toThrow();
    expect(set({ "gmail-mcp.email_address": "x".repeat(1001) })).toThrow();
    expect(set({ "gmail-mcp.email_address": "x".repeat(1000) })).not.toThrow();
    expect(set({ "gmail-mcp.app_pin": "x" }, ["gmail-mcp.app_pin"])).toThrow(
      /secret/,
    );
    expect(set({ "srv.region": "x" }, ["other.region"])).toThrow(/secret/);
    expect(() => profileConfigSetArgs("research", { "a.b": "c" })).toThrow();
    expect(() => gatewayDryRunArgs("research")).toThrow();
  });

  it("mirror the app's refusals", () => {
    for (const args of [
      ["mcp", "profile", "config", "monocode_x", "--set", "x.password=1"],
      ["mcp", "profile", "config", "monocode_x", "--set", "a=b"],
      ["mcp", "profile", "config", "monocode_x"],
      ["mcp", "profile", "config", "research", "--get-all", "--format", "json"],
      ["mcp", "gateway", "run", "--profile", "monocode_x", "--verbose"],
      [
        "mcp",
        "gateway",
        "run",
        "--profile",
        "research",
        "--dry-run",
        "--verbose",
      ],
    ]) {
      expect(isAllowedDockerMcpCall(args), args.join(" ")).toBe(false);
    }
  });
});
