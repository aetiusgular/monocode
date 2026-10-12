// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke,
}));

import type { OwnedProcess } from "../../owned-processes/model/ownedProcesses";
import { handleAgentApp, type AgentAppHost } from "../../agent-app/model/agentApp";
import { newSession } from "../../sessions/model/session";
import {
  gatherPreambleParts,
  prepareSessionPreamble,
  type PreambleSession,
} from "../../session-preamble/model/sessionPreamble";
import { buildPreamble, preambleBudget } from "../../session-preamble/model/preamble";
import { setPreviewDepsForTest, startPreview, stopPreview } from "./previewStore";

const source = newSession("codex", "/code/app", "codex:test");

function run(action: string, input: Record<string, unknown>) {
  return handleAgentApp(source, `req-${Math.random()}`, action, input, {
    isMono: () => false,
  } as unknown as AgentAppHost);
}

beforeEach(async () => {
  localStorage.clear();
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === "project_context_read") return { text: null, hash: "h" };
    if (command === "session_preamble_write") return "/data/preamble.md";
    throw new Error(`unexpected ${command}`);
  });
  const processes = new Map<string, OwnedProcess>();
  let n = 0;
  setPreviewDepsForTest({
    resolveCwd: async (root) => root,
    probe: async () => ({ status: 200 }),
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
        output: "Local: http://localhost:5173/\n",
      };
      processes.set(process.id, process);
      return process;
    },
    stop: async () => true,
    process: (id) => processes.get(id),
    subscribe: () => () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  });
  await startPreview({
    sessionId: source.id,
    project: "/code/app",
    workCwd: "/code/app",
    candidate: {
      key: "script:dev",
      label: "npm run dev",
      source: "package.json",
      program: "npm",
      args: ["run", "dev"],
      cwd: "",
      env: {},
      autoPort: false,
    },
    confirmedByUser: true,
  });
});

afterEach(() => setPreviewDepsForTest(null));

describe("the app actions through F7", () => {
  it("routes preview.* to this chat's preview", async () => {
    await expect(run("preview.status", {})).resolves.toMatchObject({
      running: true,
      url: "http://localhost:5173/",
      command: "npm run dev",
    });
    await expect(run("preview.logs", { lines: 1 })).resolves.toEqual({
      lines: ["Local: http://localhost:5173/"],
    });
  });

  it("refuses fields an action does not take, before anything runs", async () => {
    await expect(run("preview.restart", { command: "rm -rf ~" })).rejects.toThrow(
      /Unknown preview.restart fields: command/,
    );
    await expect(run("preview.status", { sessionId: "other" })).rejects.toThrow(
      /Unknown preview.status fields/,
    );
    await expect(run("preview.start", {})).rejects.toThrow(/Unknown app action/);
  });
});

describe("the status line through F2", () => {
  const session = (): PreambleSession =>
    ({ id: source.id, harness: "codex", model: "codex:qwen2.5:7b" }) as PreambleSession;

  it("is one part while the preview runs, and gone after it stops", async () => {
    let parts = await gatherPreambleParts({ session: session(), project: "/code/app", commandFirst: false });
    expect(parts.map((part) => part.id)).toEqual(["previews"]);
    expect(parts[0].text).toContain("http://localhost:5173/");
    await stopPreview(source.id);
    parts = await gatherPreambleParts({ session: session(), project: "/code/app", commandFirst: false });
    expect(parts).toEqual([]);
  });

  it("fits the 16k model's budget and reaches Codex as developer instructions", async () => {
    const parts = await gatherPreambleParts({ session: session(), project: "/code/app", commandFirst: false });
    const built = buildPreamble(parts, preambleBudget(16_384));
    expect(built.omitted).toEqual([]);
    const prepared = await prepareSessionPreamble({
      session: session(),
      project: "/code/app",
      commandFirst: false,
    });
    expect(prepared.developerInstructions).toContain("Do not start another dev server");
  });
});
