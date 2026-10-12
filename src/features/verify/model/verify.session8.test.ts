// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OwnedProcess } from "../../owned-processes/model/ownedProcesses";
import type { Block } from "../../sessions/model/session";
import {
  setPreviewDepsForTest,
  startPreview,
  stopPreview,
  type PreviewProbeResult,
} from "../../app-preview/model/previewStore";
import {
  errorLines,
  evaluateVerify,
  markOutput,
  MAX_REPORT_CHARS,
  outputSince,
} from "./verify";
import {
  latestVerify,
  noteAutoSend,
  noteTurnEnd,
  noteTurnStart,
  resetVerifyForTest,
  setVerifyAuto,
  setVerifyDepsForTest,
  turnEdges,
  verifyNow,
  verifyState,
} from "./verifyStore";

describe("errorLines", () => {
  it("finds error lines through colour codes and leaves the rest", () => {
    const text = [
      "\x1b[32mVITE ready\x1b[0m",
      "\x1b[31m[vite] Internal server error: Failed to resolve import \"./x\"\x1b[0m",
      "  at TransformPluginContext.error (file:///x.js:1:1)",
      "Found 0 errors.",
      "compiled without errors",
      "Unhandled Runtime Error",
      "Traceback (most recent call last):",
      "npm ERR! code ELIFECYCLE",
      "Error: listen EADDRINUSE: address already in use :::3000",
      "using an error boundary here",
      "hmr update /src/App.tsx",
    ].join("\n");
    expect(errorLines(text)).toEqual([
      '[vite] Internal server error: Failed to resolve import "./x"',
      "at TransformPluginContext.error (file:///x.js:1:1)",
      "Unhandled Runtime Error",
      "Traceback (most recent call last):",
      "npm ERR! code ELIFECYCLE",
      "Error: listen EADDRINUSE: address already in use :::3000",
    ]);
  });

  it("de-duplicates, cuts long lines and keeps the newest twenty", () => {
    const many = Array.from({ length: 30 }, (_, i) => `error ${i}`).join("\n");
    const lines = errorLines(`${many}\nerror 29\n`);
    expect(lines).toHaveLength(20);
    expect(lines.at(-1)).toBe("error 29");
    expect(errorLines(`error ${"x".repeat(1_000)}`)[0].length).toBe(300);
  });
});

describe("outputSince", () => {
  it("reads only what came after the mark", () => {
    const before = "boot\nready\n";
    const mark = markOutput(before);
    expect(outputSince(mark, `${before}error: new\n`)).toBe("error: new\n");
    expect(outputSince(undefined, "all")).toBe("all");
  });

  it("finds the mark after the front was cut, and reads everything when lost", () => {
    const before = `${"a".repeat(1_000)}\nmark line\n`;
    const mark = markOutput(before);
    const trimmed = `${before.slice(500)}new\n`;
    expect(outputSince(mark, trimmed)).toBe("new\n");
    expect(outputSince(mark, "completely different\n")).toBe("completely different\n");
    expect(outputSince(markOutput(""), "fresh")).toBe("fresh");
  });
});

describe("evaluateVerify", () => {
  const base = {
    sessionId: "s1",
    turnKey: "u1",
    alive: true,
    newOutput: "hmr update\n",
    url: "http://localhost:5173/",
    http: { status: 200 },
    at: 1,
  };

  it("passes when the server runs, prints no errors and answers below 500", () => {
    const result = evaluateVerify(base);
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.ok)).toEqual([true, true, true]);
    expect(evaluateVerify({ ...base, http: { status: 404 } }).ok).toBe(true);
  });

  it("fails each check on its own", () => {
    expect(evaluateVerify({ ...base, alive: false, exitDetail: "The server exited with code 1" }).checks[0]).toEqual({
      id: "alive",
      ok: false,
      detail: "The server exited with code 1",
    });
    expect(evaluateVerify({ ...base, newOutput: "SyntaxError: x" }).checks[1].ok).toBe(false);
    expect(evaluateVerify({ ...base, http: { status: 500 } }).checks[2].ok).toBe(false);
    expect(
      evaluateVerify({ ...base, http: { error: "Connection refused" } }).checks[2].detail,
    ).toBe("GET http://localhost:5173/ got no answer: Connection refused");
    expect(evaluateVerify({ ...base, url: undefined, http: undefined }).checks[2].ok).toBe(false);
  });

  it("writes a report of at most 1,500 characters, newest errors kept", () => {
    const output = Array.from({ length: 40 }, (_, i) => `error ${i} ${"y".repeat(250)}`).join("\n");
    const result = evaluateVerify({ ...base, newOutput: output, http: { status: 502 } });
    expect(result.report.length).toBeLessThanOrEqual(MAX_REPORT_CHARS);
    expect(result.report).toContain("returned 502");
    expect(result.report).toContain("error 39");
    expect(result.report).not.toContain("error 0 ");
    expect(result.report).toContain("do not start another one");
  });
});

describe("the turn watch", () => {
  let processes: Map<string, OwnedProcess>;
  let probe: PreviewProbeResult;
  let probes: string[];

  const user = (id: string): Block => ({ id, role: "user", text: "fix it" });
  const edit: Block = {
    id: "t1",
    role: "tool",
    text: "Edit src/App.tsx",
    tool: { title: "Edit src/App.tsx", kind: "edit", status: "completed" },
  };
  const read: Block = {
    id: "t2",
    role: "tool",
    text: "Read src/App.tsx",
    tool: { title: "Read src/App.tsx", kind: "read", status: "completed" },
  };

  beforeEach(async () => {
    localStorage.clear();
    resetVerifyForTest();
    processes = new Map();
    probe = { status: 200 };
    probes = [];
    let n = 0;
    setPreviewDepsForTest({
      resolveCwd: async (root) => root,
      probe: async () => probe,
      start: async (input) => {
        const process: OwnedProcess = {
          id: `p${++n}`,
          sessionId: input.sessionId,
          cwd: input.cwd,
          kind: "server",
          title: input.title,
          command: input.command,
          status: "running",
          startedAt: 0,
          output: "ready\n",
        };
        processes.set(process.id, process);
        return process;
      },
      stop: async (id) => {
        const process = processes.get(id);
        if (process) processes.set(id, { ...process, status: "exited", exitCode: null });
        return true;
      },
      process: (id) => processes.get(id),
      subscribe: () => () => undefined,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    });
    setVerifyDepsForTest({
      probe: async (url) => {
        probes.push(url);
        return probe;
      },
      now: () => 5,
    });
    await startPreview({
      sessionId: "s1",
      project: "/p",
      workCwd: "/p",
      candidate: {
        key: "script:dev",
        label: "npm run dev",
        source: "package.json",
        program: "npm",
        args: ["run", "dev"],
        cwd: "",
        env: {},
        port: 5173,
        autoPort: false,
      },
      confirmedByUser: true,
    });
  });

  afterEach(() => {
    setVerifyDepsForTest(null);
    setPreviewDepsForTest(null);
  });

  function write(output: string) {
    const process = processes.get("p1")!;
    processes.set("p1", { ...process, output: process.output + output });
  }

  it("sees busy edges, and not a chat first seen mid-turn", () => {
    expect(turnEdges([{ id: "s1", busy: true, blocks: [] }]).started).toEqual([]);
    expect(turnEdges([{ id: "s1", busy: false, blocks: [] }]).ended).toHaveLength(1);
    expect(turnEdges([{ id: "s1", busy: true, blocks: [] }]).started).toHaveLength(1);
    expect(turnEdges([]).gone).toEqual(["s1"]);
  });

  it("checks after a turn that edited files, reading only that turn's output", async () => {
    write("error: from an older turn\n");
    noteTurnStart({ id: "s1", busy: true, blocks: [user("u1")] });
    write("hmr update\n");
    const outcome = await noteTurnEnd({ id: "s1", blocks: [user("u1"), edit] });
    expect(outcome?.result.ok).toBe(true);
    expect(probes).toEqual(["http://localhost:5173/"]);
    expect(latestVerify("s1", [user("u1"), edit])?.turnKey).toBe("u1");
    // A later turn hides the card.
    expect(latestVerify("s1", [user("u1"), edit, user("u2")])).toBeUndefined();
  });

  it("does not check a turn that changed nothing, or a chat with no preview", async () => {
    noteTurnStart({ id: "s1", busy: true, blocks: [user("u1")] });
    expect(await noteTurnEnd({ id: "s1", blocks: [user("u1"), read] })).toBeUndefined();
    noteTurnStart({ id: "s2", busy: true, blocks: [user("u1")] });
    expect(await noteTurnEnd({ id: "s2", blocks: [user("u1"), edit] })).toBeUndefined();
    expect(probes).toEqual([]);
  });

  it("checks a server that crashed during the turn, and never restarts it", async () => {
    noteTurnStart({ id: "s1", busy: true, blocks: [user("u1")] });
    processes.set("p1", { ...processes.get("p1")!, status: "exited", exitCode: 1 });
    const outcome = await noteTurnEnd({ id: "s1", blocks: [user("u1"), edit] });
    expect(outcome?.result.ok).toBe(false);
    expect(outcome?.result.checks[0].detail).toBe("The server exited with code 1");
    expect(probes).toEqual([]);
    expect(processes.size).toBe(1);
  });

  it("sends a failure by itself only when switched on, at most twice in a row", async () => {
    probe = { status: 500 };
    const turn = async (key: string) => {
      noteTurnStart({ id: "s1", busy: true, blocks: [user(key)] });
      return noteTurnEnd({ id: "s1", blocks: [user(key), edit] });
    };
    expect((await turn("u1"))?.autoSend).toBe(false);
    setVerifyAuto("s1", true);
    let outcome = await turn("u2");
    expect(outcome?.autoSend).toBe(true);
    noteAutoSend("s1");
    outcome = await turn("u3");
    expect(outcome?.autoSend).toBe(true);
    noteAutoSend("s1");
    outcome = await turn("u4");
    expect(outcome?.autoSend).toBe(false);
    // A turn the user sends resets the count.
    outcome = await turn("u5");
    expect(outcome?.autoSend).toBe(true);
    // A pass resets it too.
    noteAutoSend("s1");
    probe = { status: 200 };
    await turn("u6");
    expect(verifyState("s1").autoSends).toBe(0);
  });

  it("skips a server whose launch file says autoVerify false", async () => {
    await startPreview({
      sessionId: "s1",
      project: "/p",
      workCwd: "/p",
      candidate: {
        key: "launch:web",
        label: "web",
        source: "launch.json",
        program: "npm",
        args: ["run", "dev"],
        cwd: "",
        env: {},
        port: 5173,
        autoPort: false,
        autoVerify: false,
      },
      confirmedByUser: true,
    });
    noteTurnStart({ id: "s1", busy: true, blocks: [user("u1")] });
    expect(await noteTurnEnd({ id: "s1", blocks: [user("u1"), edit] })).toBeUndefined();
  });

  it("checks now on request, and returns nothing for a chat without a preview", async () => {
    expect(await verifyNow("s9", "manual")).toBeUndefined();
    await stopPreview("s1");
    const result = await verifyNow("s1", "manual");
    expect(result?.checks[0].ok).toBe(false);
    expect(probes).toEqual([]);
  });
});
