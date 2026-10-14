// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  OwnedProcess,
  StartOwnedProcessInput,
} from "../../owned-processes/model/ownedProcesses";
import { AUTO_PORT_HOST_NOTE, previewConfirmText } from "./confirmText";
import {
  namedPorts,
  parseLaunchJson,
  type PreviewCandidate,
} from "./launchConfig";
import {
  ADDRESS_FALLBACK_MS,
  findAddress,
  previewForSession,
  setPreviewDepsForTest,
  startPreview,
  type PreviewProbeResult,
} from "./previewStore";

// Mac tests 6.18 (a server that prints no URL stayed "No address yet") and
// 6.17 (an autoPort server listened on every interface).

type Fake = {
  starts: StartOwnedProcessInput[];
  probes: string[];
  answers: Record<string, PreviewProbeResult>;
  timers: { handler: () => void; ms: number }[];
  script: string;
  launch?: string;
  now: number;
};
let fake: Fake;

beforeEach(() => {
  localStorage.clear();
  fake = {
    starts: [],
    probes: [],
    answers: {},
    timers: [],
    script:
      "PORT=5199 node -e \"require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT)\"",
    now: 1_000,
  };
  const processes = new Map<string, OwnedProcess>();
  setPreviewDepsForTest({
    readConfig: async () => ({
      packageJson: JSON.stringify({ scripts: { dev: fake.script } }),
      launchJson: fake.launch ?? null,
      lockfiles: [],
    }),
    resolveCwd: async (root) => root,
    freePort: async () => 53_261,
    listeningPorts: async () => [],
    probe: async (url) => {
      fake.probes.push(url);
      return fake.answers[url] ?? { error: "Connection refused" };
    },
    start: async (input) => {
      fake.starts.push(input);
      const process: OwnedProcess = {
        id: `owned-${fake.starts.length}`,
        sessionId: input.sessionId,
        cwd: input.cwd,
        kind: "server",
        title: input.title,
        command: input.command,
        status: "running",
        startedAt: fake.now,
        // It listens, and prints nothing.
        output: "",
      };
      processes.set(process.id, process);
      return process;
    },
    stop: async () => true,
    process: (id) => processes.get(id),
    subscribe: () => () => undefined,
    setTimeout: (handler, ms) => {
      fake.timers.push({ handler, ms });
      return fake.timers.length;
    },
    clearTimeout: () => undefined,
    now: () => fake.now,
  });
});

afterEach(() => setPreviewDepsForTest(null));

const devScript = (body: string): PreviewCandidate => ({
  key: "script:dev",
  label: "npm run dev",
  source: "package.json",
  program: "npm",
  args: ["run", "dev"],
  cwd: "",
  env: {},
  autoPort: false,
  scriptBody: body,
});

describe("namedPorts", () => {
  it("reads --port, -p and PORT= and nothing fragile", () => {
    expect(namedPorts(devScript("PORT=5199 node server.js"))).toEqual([5199]);
    expect(namedPorts(devScript("vite --port 5173"))).toEqual([5173]);
    expect(namedPorts(devScript("serve -p 8080 ."))).toEqual([8080]);
    expect(namedPorts(devScript("x --port=3001 && PORT='4000' y"))).toEqual([
      3001, 4000,
    ]);
    expect(namedPorts(devScript('node -e "server.listen(5199)"'))).toEqual([]);
    expect(namedPorts(devScript("APP_PORT=5199 node x"))).toEqual([]);
    expect(namedPorts(devScript("node x --port 99999"))).toEqual([]);
  });
});

describe("a server that prints no address", () => {
  it("probes the port its script names, on loopback, and takes a 2xx-4xx answer", async () => {
    fake.answers["http://localhost:5199/"] = { status: 404 };
    const started = await startPreview({
      sessionId: "s1",
      project: "/Users/tony/no url",
      workCwd: "/Users/tony/no url",
      candidate: devScript(fake.script),
      confirmedByUser: true,
    });
    expect(started.status).toBe("starting");
    expect(started.url).toBeUndefined();
    expect(fake.timers.at(-1)?.ms).toBe(ADDRESS_FALLBACK_MS);
    expect(fake.probes).toEqual([]);
    fake.timers.at(-1)!.handler();
    await Promise.resolve();
    await Promise.resolve();
    const found = await findAddress("s1");
    expect(found?.url).toBe("http://localhost:5199/");
    expect(found?.status).toBe("ready");
    expect(found?.port).toBe(5199);
    expect(fake.probes.every((url) => url === "http://localhost:5199/")).toBe(
      true,
    );
  });

  it("keeps trying while it does not answer, and takes no 5xx as an address", async () => {
    fake.answers["http://localhost:5199/"] = { status: 502 };
    await startPreview({
      sessionId: "s1",
      project: "/p",
      workCwd: "/p",
      candidate: devScript(fake.script),
      confirmedByUser: true,
    });
    const timers = fake.timers.length;
    const still = await findAddress("s1");
    expect(still?.url).toBeUndefined();
    expect(still?.status).toBe("starting");
    expect(fake.timers.length).toBe(timers + 1);
  });

  it("does not guess a port for a server that names no port", async () => {
    // Mac fix 6.18 (third pass): the address search is still scheduled, to
    // ask which ports the server's own processes listen on (none here).
    fake.script = "node server.js";
    await startPreview({
      sessionId: "s1",
      project: "/p",
      workCwd: "/p",
      candidate: devScript(fake.script),
      confirmedByUser: true,
    });
    expect(fake.timers.map((t) => t.ms)).toEqual([ADDRESS_FALLBACK_MS]);
    await findAddress("s1");
    expect(fake.probes).toEqual([]);
    expect(previewForSession("s1")?.url).toBeUndefined();
  });
});

describe("a launch.json entry on a free port", () => {
  const launch = JSON.stringify({
    configurations: [
      {
        name: "serve",
        runtimeExecutable: "npx",
        runtimeArgs: ["serve", "."],
        autoPort: true,
      },
    ],
  });

  it("passes HOST=127.0.0.1 with PORT", async () => {
    fake.launch = launch;
    const candidate = parseLaunchJson(launch).candidates[0];
    await startPreview({
      sessionId: "s1",
      project: "/p",
      workCwd: "/p",
      candidate,
      confirmedByUser: true,
    });
    expect(fake.starts[0].command.env).toEqual({
      HOST: "127.0.0.1",
      PORT: "53261",
    });
  });

  it("keeps a HOST the launch file sets", async () => {
    const own = JSON.stringify({
      configurations: [
        {
          name: "serve",
          runtimeExecutable: "npx",
          runtimeArgs: ["serve", "."],
          env: { HOST: "localhost" },
          autoPort: true,
        },
      ],
    });
    fake.launch = own;
    await startPreview({
      sessionId: "s1",
      project: "/p",
      workCwd: "/p",
      candidate: parseLaunchJson(own).candidates[0],
      confirmedByUser: true,
    });
    expect(fake.starts[0].command.env).toEqual({
      HOST: "localhost",
      PORT: "53261",
    });
  });

  it("says in the confirm box what HOST cannot ensure", () => {
    const candidate = parseLaunchJson(launch).candidates[0];
    expect(previewConfirmText(candidate).host).toBe(
      "MonoCode passes HOST=127.0.0.1. A server that ignores it may listen on every network interface.",
    );
    expect(AUTO_PORT_HOST_NOTE).toContain("HOST=127.0.0.1");
    expect(previewConfirmText(devScript("vite")).host).toBeUndefined();
  });
});
