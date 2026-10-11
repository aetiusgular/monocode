import { createRoot } from "react-dom/client";
import { ConnectorsPage } from "../../src/features/gateway-connectors/ui/ConnectorsPage";
import type { Mock } from "vitest";
import { CATALOG_FIXTURE } from "../../src/features/gateway-connectors/model/__fixtures__/catalog";
import { fakeDocker } from "../../src/features/gateway-connectors/model/__fixtures__/fakeDocker";
import "../../src/styles/index.css";

const PARAMS = new URLSearchParams(location.search);
/** Docker Desktop is closed: every call fails as the CLI says. */
const STOPPED = PARAMS.get("docker") === "stopped";

localStorage.clear();

/** More hosted and container servers, so the grid has rows to lay out. */
const EXTRA = [
  ["linear", "Linear", "remote", "Issues, projects and cycles in Linear."],
  ["slack", "Slack", "server", "Read channels and post messages to Slack."],
  ["stripe-remote", "Stripe", "remote", "Payments, customers and invoices."],
  ["sentry-remote", "Sentry", "remote", "Errors and performance issues."],
  ["postgres", "Postgres", "server", "Query a Postgres database read-only."],
  ["asana", "Asana", "server", "Tasks and projects in Asana."],
].map(([name, title, type, description]) => ({
  type,
  snapshot: {
    server: {
      name,
      type,
      title,
      description,
      ...(type === "remote"
        ? {
            remote: { url: `https://mcp.${name}.example/mcp` },
            oauth: { providers: [{ provider: name }] },
          }
        : {
            image: `mcp/${name}`,
            secrets: [{ name: `${name}.api_key`, env: "KEY" }],
          }),
      tools: [{ name: `${name}_search` }, { name: `${name}_read` }],
    },
  },
}));

const CATALOG = {
  ...CATALOG_FIXTURE,
  servers: [...CATALOG_FIXTURE.servers, ...EXTRA],
};

const calls: { args: string[]; stdin?: boolean }[] = [];
(window as unknown as { __docker: typeof calls }).__docker = calls;

/**
 * The same fake `docker mcp` the unit tests use: profiles, config, secrets,
 * sign-ins and dry runs kept in memory. `?time=fails` makes Time's dry run
 * fail as an image with no Apple Silicon build does; `?signin=hangs` keeps
 * the browser sign-in open.
 */
type Impl = (args: string[], options?: { stdin?: string }) => Promise<unknown>;
let impl: Impl = async () => undefined;
const shim = {
  mockImplementation: (next: Impl) => {
    impl = next;
  },
};
const fake = fakeDocker(shim as unknown as Mock, {
  dryRun:
    PARAMS.get("time") === "fails"
      ? {
          time: "warning: pulling docker image mcp/time: Error response from daemon: no matching manifest for linux/arm64/v8 in the manifest list entries\n> 0 tools listed",
        }
      : {},
  fail: STOPPED
    ? "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"
    : undefined,
});
fake.authorizeHangs = PARAMS.get("signin") === "hangs";

(
  window as unknown as {
    __TAURI_INTERNALS__: {
      invoke: (
        command: string,
        args?: Record<string, unknown>,
      ) => Promise<unknown>;
    };
  }
).__TAURI_INTERNALS__ = {
  invoke: async (command, payload) => {
    if (command !== "docker_mcp") {
      throw new Error(`The fixture has no ${command}.`);
    }
    const args = payload?.args as string[];
    // Never the value: only whether one came on stdin.
    calls.push({ args, stdin: typeof payload?.stdin === "string" });
    if (!STOPPED && args[1] === "catalog" && args[2] === "show") {
      return {
        stdout: JSON.stringify(CATALOG),
        stderr: "",
        success: true,
        docker: "/usr/local/bin/docker",
      };
    }
    // Slow enough to see the Testing state.
    if (args[1] === "gateway") await new Promise((r) => setTimeout(r, 150));
    return impl(args, {
      stdin: typeof payload?.stdin === "string" ? payload.stdin : undefined,
    });
  },
};

/** The page inside the same frame Settings gives it. */
function Fixture() {
  return (
    <div className="@container/settings h-full overflow-y-auto bg-background-base">
      <div className="mx-auto w-full max-w-5xl px-5 py-6 @min-[560px]/settings:px-8 @min-[560px]/settings:py-8">
        <header className="pb-4">
          <h1 className="text-[20px] font-semibold leading-tight text-content">
            Connectors
          </h1>
        </header>
        <ConnectorsPage cwd="/repo" />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
