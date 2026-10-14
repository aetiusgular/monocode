// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  OwnedProcess,
  StartOwnedProcessInput,
} from "../../owned-processes/model/ownedProcesses";
import { previewCandidates } from "./launchConfig";
import {
  ADDRESS_FALLBACK_MS,
  findAddress,
  previewForSession,
  PROBE_GIVE_UP_MS,
  setPreviewDepsForTest,
  startPreview,
  stopPreview,
  type PreviewProbeResult,
} from "./previewStore";

// Mac retest 6.18: a server on a fixed port that MonoCode did not pass and
// the command does not name (`listen(5199)`) stayed "No address yet". After
// the named ports, MonoCode asks which ports the preview's own processes
// listen on and probes those on loopback.

type Fake = {
  probes: string[];
  answers: Record<string, PreviewProbeResult>;
  timers: { handler: () => void; ms: number }[];
  listening: number[] | Error;
  asked: string[];
  onAsk?: () => void;
  script: string;
  now: number;
};
let fake: Fake;

beforeEach(() => {
  localStorage.clear();
  fake = {
    probes: [],
    answers: {},
    timers: [],
    listening: [],
    asked: [],
    script: "",
    now: 1_000,
  };
  const processes = new Map<string, OwnedProcess>();
  let count = 0;
  setPreviewDepsForTest({
    readConfig: async () => ({
      packageJson: JSON.stringify({ scripts: { dev: fake.script } }),
      launchJson: null,
      lockfiles: [],
    }),
    resolveCwd: async (root) => root,
    freePort: async () => 53_261,
    probe: async (url) => {
      fake.probes.push(url);
      return fake.answers[url] ?? { error: "Connection refused" };
    },
    listeningPorts: async (processId) => {
      fake.asked.push(processId);
      fake.onAsk?.();
      if (fake.listening instanceof Error) throw fake.listening;
      return fake.listening;
    },
    start: async (input: StartOwnedProcessInput) => {
      count += 1;
      const process: OwnedProcess = {
        id: `owned-${count}`,
        sessionId: input.sessionId,
        cwd: input.cwd,
        kind: "server",
        title: input.title,
        command: input.command,
        status: "running",
        startedAt: fake.now,
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

/** The candidate MonoCode itself reads from package.json's dev script. */
const script = (body: string) => {
  const found = previewCandidates({
    packageJson: JSON.stringify({ scripts: { dev: body } }),
    launchJson: null,
    lockfiles: [],
  }).candidates.find((c) => c.key === "script:dev");
  if (!found) throw new Error("no dev candidate");
  return found;
};

const HARD_CODED =
  "node -e \"require('http').createServer((q,s)=>s.end('ok')).listen(5199)\"";

async function start(body = HARD_CODED) {
  fake.script = body;
  return startPreview({
    sessionId: "s1",
    project: "/Users/tony/no url",
    workCwd: "/Users/tony/no url",
    candidate: script(body),
    confirmedByUser: true,
  });
}

describe("a server on a port nobody named", () => {
  it("is found through the ports its own processes listen on", async () => {
    fake.listening = [5199];
    fake.answers["http://localhost:5199/"] = { status: 200 };
    const started = await start();
    expect(started.url).toBeUndefined();
    // Looked for after the same delay as a named port.
    expect(fake.timers.map((t) => t.ms)).toEqual([ADDRESS_FALLBACK_MS]);
    const found = await findAddress("s1");
    expect(fake.asked).toEqual(["owned-1"]);
    expect(found?.url).toBe("http://localhost:5199/");
    expect(found?.port).toBe(5199);
    expect(found?.status).toBe("ready");
    // Loopback only.
    expect(fake.probes).toEqual(["http://localhost:5199/"]);
  });

  it("tries the named port first and does not probe it twice", async () => {
    fake.listening = [5199, 24678];
    fake.answers["http://localhost:24678/"] = { status: 404 };
    await start("PORT=5199 node server.js");
    const found = await findAddress("s1");
    expect(fake.probes).toEqual([
      "http://localhost:5199/",
      "http://localhost:24678/",
    ]);
    expect(found?.url).toBe("http://localhost:24678/");
  });

  it("does not ask the OS when a named port answers", async () => {
    fake.listening = [7000];
    fake.answers["http://localhost:5173/"] = { status: 200 };
    await start("vite --port 5173");
    const found = await findAddress("s1");
    expect(found?.url).toBe("http://localhost:5173/");
    expect(fake.asked).toEqual([]);
  });

  it("drops ports that are not ports, and takes no 5xx", async () => {
    fake.listening = [0, 70_000, 1.5, -1, 8080];
    fake.answers["http://localhost:8080/"] = { status: 503 };
    await start();
    const before = fake.timers.length;
    const still = await findAddress("s1");
    expect(fake.probes).toEqual(["http://localhost:8080/"]);
    expect(still?.url).toBeUndefined();
    expect(still?.status).toBe("starting");
    // Tried again later.
    expect(fake.timers.length).toBe(before + 1);
  });

  it("keeps trying when the lookup fails, and stops after the give-up time", async () => {
    fake.listening = new Error("lsof missing");
    await start();
    const before = fake.timers.length;
    await findAddress("s1");
    expect(fake.probes).toEqual([]);
    expect(fake.timers.length).toBe(before + 1);
    fake.now += PROBE_GIVE_UP_MS;
    const timers = fake.timers.length;
    await findAddress("s1");
    expect(fake.timers.length).toBe(timers);
    expect(previewForSession("s1")?.url).toBeUndefined();
  });

  it("probes nothing for a preview stopped while the OS was asked", async () => {
    fake.listening = [5199];
    fake.answers["http://localhost:5199/"] = { status: 200 };
    await start();
    fake.onAsk = () => void stopPreview("s1");
    const after = await findAddress("s1");
    expect(fake.probes).toEqual([]);
    expect(after?.status).toBe("stopped");
    expect(after?.url).toBeUndefined();
  });
});
