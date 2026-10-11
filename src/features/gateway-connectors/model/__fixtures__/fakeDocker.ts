import type { Mock } from "vitest";
import { CATALOG_FIXTURE } from "./catalog";

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

const OK = (server: string, tools = 4) =>
  `> ${server}: (${tools} tools)\n> ${tools} tools listed in 1.17s`;

/** A fake `docker mcp` that keeps profiles, secrets, config and sign-ins. */
export function fakeDocker(
  runDockerMcp: Mock,
  initial: {
    profiles?: string[];
    secrets?: string[];
    authorized?: string[];
    config?: Record<string, Record<string, string>>;
    dryRun?: Record<string, string>;
    fail?: string;
    /** `monocode/extra` as `catalog show` prints it; absent means none. */
    extraCatalog?: unknown;
  },
) {
  const profiles = new Map(
    (initial.profiles ?? []).map((server) => [
      `monocode_${server.replace(/[^a-z0-9]/g, "_")}`,
      server,
    ]),
  );
  const secrets = new Set(initial.secrets ?? []);
  const authorized = new Set(initial.authorized ?? []);
  const config = initial.config ?? {};
  const fake = {
    fail: initial.fail,
    authorizeHangs: false,
    /** Real Docker: authorize opens the browser and exits; approval comes later. */
    authorizeOpensOnly: false,
    secrets,
    authorized,
    config,
  };
  runDockerMcp.mockImplementation(
    async (args: string[], options: { stdin?: string } = {}) => {
      if (fake.fail) throw new Error(fake.fail);
      const out = (value: unknown, stderr = "", success = true) => ({
        stdout: typeof value === "string" ? value : JSON.stringify(value),
        stderr,
        success,
        docker: DOCKER,
      });
      const [, group, verb] = args;
      if (group === "catalog" && verb === "show") {
        if (args[3] === "monocode/extra") {
          if (!initial.extraCatalog) throw new Error("catalog not found");
          return out(initial.extraCatalog);
        }
        return out(CATALOG_FIXTURE);
      }
      if (group === "profile" && verb === "list") {
        return out([...profiles].map(([id, server]) => profile(id, server)));
      }
      if (group === "profile" && verb === "create") {
        profiles.set(args[6], args[8].split("/").pop()!);
        return out("");
      }
      if (group === "profile" && verb === "remove") {
        profiles.delete(args[3]);
        return out("");
      }
      if (group === "profile" && verb === "config") {
        const id = args[3];
        if (args[4] === "--get-all") return out(config[id] ?? {});
        for (let i = 4; i < args.length; i += 2) {
          const at = args[i + 1].indexOf("=");
          config[id] = {
            ...config[id],
            [args[i + 1].slice(0, at)]: args[i + 1].slice(at + 1),
          };
        }
        return out("");
      }
      if (group === "secret" && verb === "ls") {
        return out([...secrets].map((name) => ({ name, provider: "docker" })));
      }
      if (group === "secret" && verb === "set") {
        if (options.stdin) secrets.add(args[3]);
        return out("");
      }
      if (group === "oauth" && verb === "ls") {
        // Docker lists hugging-face too, unauthorized, though it needs no
        // sign-in.
        return out(
          [...profiles.values()]
            .filter((s) => s === "notion-remote" || s === "hugging-face")
            .map((app) => ({
              app,
              provider: app,
              authorized: authorized.has(app),
            })),
        );
      }
      if (group === "oauth" && verb === "authorize") {
        if (fake.authorizeHangs) return new Promise(() => undefined);
        if (fake.authorizeOpensOnly) return out("Opening your browser");
        authorized.add(args[3]);
        return out("");
      }
      if (group === "gateway") {
        const server = profiles.get(args[4])!;
        const stderr = initial.dryRun?.[server] ?? OK(server);
        return out("", stderr, !/Validation failed/.test(stderr));
      }
      return out("");
    },
  );
  return fake;
}
