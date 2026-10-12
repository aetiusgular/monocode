import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Request = {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
};

const sent: Request[] = [];
let onLine: ((line: string) => void) | undefined;
let output = "Generated text";
let threadCount = 0;
let failTurn = false;
let missingResume = false;
const spawnChild = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => undefined),
);
const prepareCodexMonoContext = vi.hoisted(() =>
  vi.fn(async (_input: unknown) => ({
    config: { sqlite_home: "/private/mono" },
    hasThread: true,
  })),
);
vi.mock("./codexStore", () => ({ prepareCodexMonoContext }));

function receive(message: unknown) {
  onLine?.(JSON.stringify(message));
}

vi.mock("../../core/child", () => ({
  resolveCodexBinary: async () => ({ path: "/fake/codex" }),
  spawnChild,
  restoreMonoCodexAgentState: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (value: string) => void) => {
    onLine = line;
  },
  writeChild: async (_id: string, line: string) => {
    const request = JSON.parse(line) as Request;
    sent.push(request);
    if (request.id === undefined) return;
    if (request.method === "thread/start") {
      receive({
        id: request.id,
        result: { thread: { id: `thread_${++threadCount}` } },
      });
    } else if (request.method === "thread/resume") {
      receive(
        missingResume
          ? { id: request.id, error: { message: "thread not found" } }
          : {
              id: request.id,
              result: { thread: { id: request.params?.threadId } },
            },
      );
    } else if (request.method === "turn/start") {
      receive({ id: request.id, result: { turn: { id: "turn_1" } } });
      setTimeout(() => {
        receive({
          method: "item/agentMessage/delta",
          params: { delta: output },
        });
        receive({
          method: "turn/completed",
          params: {
            turn: {
              id: "turn_1",
              status: failTurn ? "failed" : "completed",
              ...(failTurn ? { error: { message: "Generation failed" } } : {}),
            },
          },
        });
      }, 0);
    } else {
      receive({ id: request.id, result: {} });
    }
  },
}));

vi.mock("../../../../platform/tauri/fs", () => ({
  gitStagedContext: async () => ({
    branch: "helpers",
    summary: "1 file changed",
    patch: "diff",
  }),
  gitRangeContext: async () => ({
    base: "main",
    head: "helpers",
    commitSummary: "Keep helper history clean",
    diffSummary: "1 file changed",
    diffPatch: "diff",
  }),
}));

const { runCodexTextPrompt, stopCodexTextPrompt, warmupCodexText } =
  await import("./codexText");
const { resetHarnessModelOverlays, setHarnessModels } = await import(
  "../../../../features/sessions/model/models"
);

function last(method: string) {
  return [...sent].reverse().find((request) => request.method === method);
}

beforeEach(() => {
  sent.length = 0;
  onLine = undefined;
  output = "Generated text";
  threadCount = 0;
  failTurn = false;
  missingResume = false;
  spawnChild.mockClear();
  resetHarnessModelOverlays();
});

afterEach(async () => {
  await stopCodexTextPrompt();
  resetHarnessModelOverlays();
});

const LOCAL = {
  id: "codex:qwen2.5:7b",
  harness: "codex" as const,
  name: "qwen2.5:7b",
  nativeId: "qwen2.5:7b",
};

it("asks a local home for no model when its catalog lacks the helper model (F6, defect 4)", async () => {
  setHarnessModels("codex", [LOCAL]);
  await expect(runCodexTextPrompt({ cwd: "/repo", prompt: "Title?" })).resolves.toBe(
    "Generated text",
  );
  expect(last("thread/start")?.params?.model).toBeUndefined();
  expect(JSON.stringify(sent)).not.toContain("luna");
  expect(last("turn/start")?.params?.collaborationMode).toBeUndefined();
});

it("sends no reasoning effort for a local model without that setting", async () => {
  setHarnessModels("codex", [LOCAL]);
  await runCodexTextPrompt({ cwd: "/repo", prompt: "Title?", model: "qwen2.5:7b" });
  const mode = last("turn/start")?.params?.collaborationMode as
    | { settings?: Record<string, unknown> }
    | undefined;
  expect(mode?.settings?.model).toBe("qwen2.5:7b");
  expect(mode?.settings?.reasoning_effort).toBeNull();
});

it("keeps the helper model when the live catalog lists it", async () => {
  setHarnessModels("codex", [
    { id: "codex:gpt-5.6-luna", harness: "codex", name: "Luna", nativeId: "gpt-5.6-luna" },
    LOCAL,
  ]);
  await runCodexTextPrompt({ cwd: "/repo", prompt: "Title?" });
  expect(JSON.stringify(last("turn/start")?.params)).toContain("gpt-5.6-luna");
});
