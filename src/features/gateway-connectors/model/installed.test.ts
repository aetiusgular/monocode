// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const runDockerMcp = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/tauri/dockerMcp", () => ({ runDockerMcp }));

import { CATALOG_FIXTURE } from "./__fixtures__/catalog";
import { fakeDocker as fakeDockerWith } from "./__fixtures__/fakeDocker";
import {
  __resetInstalled,
  __setSignInPollMs,
  addAndStart,
  addConnector,
  cancelSignIn,
  classifyDockerError,
  connectorStatus,
  installedConnector,
  installedState,
  joinConnectorStatus,
  parseOwnProfiles,
  pickSessionName,
  refreshInstalled,
  removeConnector,
  saveSetupAndTest,
  setConnectorSecret,
  signInAndTest,
  testConnector,
  testStale,
  type TestResult,
} from "./installed";

const DOCKER = "/usr/local/bin/docker";
const serverEntry = (name: string) =>
  CATALOG_FIXTURE.servers.find(
    (entry) =>
      (entry as { snapshot?: { server?: { name?: string } } }).snapshot?.server
        ?.name === name,
  )!;

const profile = (id: string, server: string) => ({
  version: 1,
  id,
  name: id,
  servers: [serverEntry(server)],
  secrets: [],
});

const fakeDocker = (initial: Parameters<typeof fakeDockerWith>[1]) =>
  fakeDockerWith(runDockerMcp, initial);

const calls = () =>
  runDockerMcp.mock.calls.map((call) => (call[0] as string[]).join(" "));

beforeEach(() => {
  localStorage.clear();
  runDockerMcp.mockReset();
  __resetInstalled();
  __setSignInPollMs(1);
});

const passed: TestResult = { at: 1, ok: true, tools: 4, output: "" };
const failed: TestResult = {
  at: 1,
  ok: false,
  tools: 0,
  reason: "No build for Apple Silicon",
  cause: "platform",
  output: "",
};

describe("joining profiles, setup and tests", () => {
  const own = parseOwnProfiles([
    profile("monocode_notion_remote", "notion-remote"),
    profile("monocode_github", "github"),
    profile("monocode_hugging_face", "hugging-face"),
    profile("monocode_gmail_mcp", "gmail-mcp"),
    profile("research", "hugging-face"),
  ]);

  it("lists only MonoCode's profiles", () => {
    expect(own.map((p) => p.profileId)).toEqual([
      "monocode_notion_remote",
      "monocode_github",
      "monocode_hugging_face",
      "monocode_gmail_mcp",
    ]);
  });

  it("asks for sign-in only where the catalog lists OAuth", () => {
    const connectors = joinConnectorStatus({
      profiles: own,
      secrets: new Set(),
      oauth: [
        { app: "notion-remote", provider: "notion-remote", authorized: false },
        { app: "hugging-face", provider: "hugging-face", authorized: false },
      ],
      sessionNames: {},
      config: { monocode_gmail_mcp: {} },
    });
    expect(
      connectors.map((c) => [c.server, c.setup, c.status, c.oauthApp]),
    ).toEqual([
      ["notion-remote", "needs-sign-in", "needs-sign-in", "notion-remote"],
      ["github", "needs-setup", "needs-setup", undefined],
      ["hugging-face", "complete", "untested", undefined],
      ["gmail-mcp", "needs-setup", "needs-setup", undefined],
    ]);
    expect(connectors[1].missingSecrets).toEqual([
      "github.personal_access_token",
    ]);
    expect(connectors[3].missingSettings).toEqual(["gmail-mcp.email_address"]);
  });

  it("needs the required config value as well as the secret", () => {
    const join = (config: Record<string, string>, secrets: string[]) =>
      joinConnectorStatus({
        profiles: own.filter((p) => p.server.name === "gmail-mcp"),
        secrets: new Set(secrets),
        oauth: [],
        sessionNames: {},
        config: { monocode_gmail_mcp: config },
      })[0];
    expect(join({}, ["gmail-mcp.password"]).setup).toBe("needs-setup");
    expect(
      join({ "gmail-mcp.email_address": "me@example.com" }, []).setup,
    ).toBe("needs-setup");
    expect(
      join({ "gmail-mcp.email_address": "me@example.com" }, [
        "gmail-mcp.password",
      ]).setup,
    ).toBe("complete");
  });

  it("is ready only once a test passed", () => {
    expect(connectorStatus("complete", undefined)).toBe("untested");
    expect(connectorStatus("complete", passed)).toBe("ready");
    expect(connectorStatus("complete", failed)).toBe("failed");
    expect(connectorStatus("needs-setup", passed)).toBe("needs-setup");
    const [hf] = joinConnectorStatus({
      profiles: own.filter((p) => p.server.name === "hugging-face"),
      secrets: new Set(),
      oauth: [],
      sessionNames: { monocode_hugging_face: "hf" },
      tests: { monocode_hugging_face: failed },
    });
    expect(hf.status).toBe("failed");
    expect(hf.test?.reason).toBe("No build for Apple Silicon");
    expect(hf.sessionName).toBe("hf");
  });

  it("names a connector after its catalog name unless that is taken", () => {
    expect(pickSessionName("linear", new Set())).toBe("linear");
    expect(pickSessionName("linear", new Set(["linear"]))).toBe(
      "linear-gateway",
    );
  });

  it("says when Docker is stopped or missing", () => {
    expect(
      classifyDockerError("Docker CLI not found. Install Docker Desktop."),
    ).toBe("missing");
    expect(
      classifyDockerError(
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      ),
    ).toBe("not-running");
    expect(classifyDockerError("unknown flag --x")).toBe("error");
  });
});

describe("the installed store", () => {
  it("refreshes with config values and keeps the list and tests across restarts", async () => {
    fakeDocker({
      profiles: ["gmail-mcp", "hugging-face"],
      config: { monocode_gmail_mcp: { "gmail-mcp.email_address": "a@b.c" } },
    });
    await refreshInstalled();
    expect(calls()).toContain(
      "mcp profile config monocode_gmail_mcp --get-all --format json",
    );
    expect(installedState().config.monocode_gmail_mcp).toEqual({
      "gmail-mcp.email_address": "a@b.c",
    });
    await testStale();
    expect(
      installedState().connectors.map((c) => [c.server, c.status]),
    ).toEqual([
      ["gmail-mcp", "needs-setup"],
      ["hugging-face", "ready"],
    ]);

    __resetInstalled({ reload: true });
    expect(installedState().dockerState).toBe("unknown");
    expect(installedState().docker).toBe(DOCKER);
    expect(installedState().config).toEqual({});
    expect(
      installedState().connectors.map((c) => [c.server, c.status]),
    ).toEqual([
      ["gmail-mcp", "needs-setup"],
      ["hugging-face", "ready"],
    ]);
    expect(localStorage.getItem("monocode.gatewayConnectors.v2")).not.toContain(
      "a@b.c",
    );
  });

  it("keeps the last list but marks Docker stopped when it does not answer", async () => {
    const fake = fakeDocker({ profiles: ["hugging-face"] });
    await refreshInstalled();
    fake.fail = "Docker Desktop is not running";
    await refreshInstalled();
    expect(installedState().dockerState).toBe("not-running");
    expect(installedState().connectors).toHaveLength(1);
  });

  it("tests with a gateway dry run and keeps the reason and output", async () => {
    fakeDocker({
      profiles: ["gmail-mcp"],
      secrets: ["gmail-mcp.password"],
      config: { monocode_gmail_mcp: { "gmail-mcp.email_address": "a@b.c" } },
      dryRun: {
        "gmail-mcp":
          "warning: pulling docker image x: Error response from daemon: no matching manifest for linux/arm64/v8 in the manifest list entries\n> 0 tools listed",
      },
    });
    await refreshInstalled();
    await testConnector(installedConnector("gmail-mcp")!);
    expect(runDockerMcp).toHaveBeenLastCalledWith(
      [
        "mcp",
        "gateway",
        "run",
        "--profile",
        "monocode_gmail_mcp",
        "--dry-run",
        "--verbose",
      ],
      { timeoutMs: 180_000 },
    );
    const after = installedConnector("gmail-mcp")!;
    expect(after.status).toBe("failed");
    expect(after.test).toMatchObject({
      ok: false,
      reason: "No build for Apple Silicon",
      cause: "platform",
    });
    expect(after.test?.output).toContain("no matching manifest");
    expect(installedState().testing).toEqual([]);
  });

  it("marks Docker stopped instead of failing the connector", async () => {
    fakeDocker({ profiles: ["hugging-face"] });
    await refreshInstalled();
    runDockerMcp.mockRejectedValueOnce(
      new Error("Cannot connect to the Docker daemon"),
    );
    await testConnector(installedConnector("hugging-face")!);
    expect(installedState().dockerState).toBe("not-running");
    expect(installedConnector("hugging-face")?.status).toBe("untested");
  });

  it("retries once after a network error while checking the image", async () => {
    fakeDocker({ profiles: ["hugging-face"] });
    await refreshInstalled();
    runDockerMcp.mockResolvedValueOnce({
      stdout: "",
      stderr:
        "verifying docker images: getting Rekor public keys: error updating to TUF remote mirror",
      success: false,
      docker: "docker",
    });
    await testConnector(installedConnector("hugging-face")!);
    const dryRuns = calls().filter((call) => call.includes("dry-run"));
    expect(dryRuns).toHaveLength(2);
    expect(installedConnector("hugging-face")?.test).toMatchObject({
      ok: true,
      tools: 4,
    });
  });

  it("re-tests results older than asked", async () => {
    fakeDocker({ profiles: ["hugging-face"] });
    await refreshInstalled();
    await testStale();
    await testStale();
    const dryRuns = () => calls().filter((call) => call.includes("dry-run"));
    expect(dryRuns()).toHaveLength(1);
    await testStale({ maxAgeMs: -1 });
    expect(dryRuns()).toHaveLength(2);
  });
});

describe("adding a connector", () => {
  it("tests one with nothing to set up straight away", async () => {
    fakeDocker({});
    expect(await addAndStart({ name: "hugging-face" })).toBe("tested");
    expect(calls()).toContain(
      "mcp profile create --name monocode-hugging-face --id monocode_hugging_face --server catalog://mcp/docker-mcp-catalog/hugging-face",
    );
    expect(installedConnector("hugging-face")?.status).toBe("ready");
  });

  it("asks for keys and settings in the setup form, then saves and tests", async () => {
    fakeDocker({});
    expect(await addAndStart({ name: "gmail-mcp" })).toBe("setup");
    expect(calls().some((call) => call.includes("dry-run"))).toBe(false);
    await saveSetupAndTest(installedConnector("gmail-mcp")!, {
      config: { "gmail-mcp.email_address": "me@example.com" },
      secrets: { "gmail-mcp.password": "app-password" },
    });
    expect(calls()).toContain(
      "mcp profile config monocode_gmail_mcp --set gmail-mcp.email_address=me@example.com",
    );
    const set = runDockerMcp.mock.calls.find((call) => call[0][2] === "set")!;
    expect(set[0]).toEqual(["mcp", "secret", "set", "gmail-mcp.password"]);
    expect(set[1].stdin).toBe("app-password");
    expect(calls().join("\n")).not.toContain("app-password");
    expect(localStorage.getItem("monocode.gatewayConnectors.v2")).not.toContain(
      "app-password",
    );
    expect(installedConnector("gmail-mcp")?.status).toBe("ready");
  });

  it("starts the sign-in for an OAuth connector, then tests", async () => {
    fakeDocker({});
    expect(await addAndStart({ name: "notion-remote" })).toBe("signing-in");
    await vi.waitFor(() =>
      expect(installedConnector("notion-remote")?.status).toBe("ready"),
    );
    const authorize = runDockerMcp.mock.calls.find(
      (call) => call[0][2] === "authorize",
    )!;
    expect(authorize).toEqual([
      ["mcp", "oauth", "authorize", "notion-remote", "--open-browser"],
      { timeoutMs: 300_000 },
    ]);
    expect(installedState().signingIn).toEqual([]);
  });

  it("finishes a sign-in seen in oauth ls while authorize is still open", async () => {
    const fake = fakeDocker({ profiles: ["notion-remote"] });
    fake.authorizeHangs = true;
    await refreshInstalled();
    const done = signInAndTest(installedConnector("notion-remote")!);
    await vi.waitFor(() =>
      expect(installedState().signingIn).toEqual(["monocode_notion_remote"]),
    );
    fake.authorized.add("notion-remote");
    expect(await done).toBe("signed-in");
    expect(installedConnector("notion-remote")?.status).toBe("ready");
  });

  it("keeps waiting after authorize exits until oauth ls says signed in", async () => {
    // Docker's authorize opens the browser and exits in under a second.
    const fake = fakeDocker({ profiles: ["notion-remote"] });
    fake.authorizeOpensOnly = true;
    await refreshInstalled();
    const done = signInAndTest(installedConnector("notion-remote")!);
    await vi.waitFor(() =>
      expect(
        runDockerMcp.mock.calls.filter((call) => call[0][2] === "ls").length,
      ).toBeGreaterThan(2),
    );
    expect(installedState().signingIn).toEqual(["monocode_notion_remote"]);
    expect(calls().some((call) => call.includes("dry-run"))).toBe(false);
    fake.authorized.add("notion-remote");
    expect(await done).toBe("signed-in");
    expect(installedConnector("notion-remote")?.status).toBe("ready");
  });

  it("stops waiting when the sign-in is cancelled", async () => {
    const fake = fakeDocker({ profiles: ["notion-remote"] });
    fake.authorizeHangs = true;
    await refreshInstalled();
    const done = signInAndTest(installedConnector("notion-remote")!);
    await vi.waitFor(() => expect(installedState().signingIn).toHaveLength(1));
    cancelSignIn("monocode_notion_remote");
    expect(await done).toBe("cancelled");
    expect(installedState().signingIn).toEqual([]);
    expect(installedConnector("notion-remote")?.status).toBe("needs-sign-in");
  });

  it("names the session server so it does not clash", async () => {
    fakeDocker({});
    await addConnector({ name: "github" }, new Set(["github"]));
    expect(installedConnector("github")?.sessionName).toBe("github-gateway");
  });

  it("removes a connector, signing it out first when asked", async () => {
    fakeDocker({ profiles: ["notion-remote"] });
    await removeConnector(
      { profileId: "monocode_notion_remote", oauthApp: "notion-remote" },
      { signOut: true },
    );
    expect(calls().slice(0, 2)).toEqual([
      "mcp oauth revoke notion-remote",
      "mcp profile remove monocode_notion_remote",
    ]);
    expect(installedState().connectors).toEqual([]);
  });

  it("hands a lone secret to Docker on stdin only", async () => {
    fakeDocker({});
    await setConnectorSecret("github.personal_access_token", "ghp_secret");
    const [args, options] = runDockerMcp.mock.calls[0];
    expect((args as string[]).join(" ")).not.toContain("ghp_secret");
    expect(options.stdin).toBe("ghp_secret");
    await expect(setConnectorSecret("x", "")).rejects.toThrow();
  });
});
