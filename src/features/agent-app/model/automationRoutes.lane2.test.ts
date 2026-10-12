// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { newSession } from "../../sessions/model/session";
import { handleAgentApp, type AgentAppHost } from "./agentApp";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke,
}));

function run(
  action: string,
  input: Record<string, unknown>,
  host: Partial<AgentAppHost> = {},
) {
  const source = newSession("codex", "/Users/tony/code/app", "codex:test");
  return handleAgentApp(source, `req-${Math.random()}`, action, input, {
    isMono: () => false,
    ...host,
  } as AgentAppHost);
}

it("routes automations.* to the automation handler (#39)", async () => {
  invoke.mockImplementation(async (command: string) => {
    if (command === "automations_list") return [];
    if (command === "project_context_read") return { text: null, hash: "h" };
    throw new Error(`unexpected ${command}`);
  });
  await expect(run("automations.list", {})).resolves.toEqual({
    automations: [],
    waitingForUser: 0,
  });
});

it("refuses fields an action does not take, before anything runs", async () => {
  invoke.mockReset();
  await expect(
    run("automations.create", {
      name: "x",
      prompt: "y",
      schedule: "daily 09:00",
      cwd: "/etc",
    }),
  ).rejects.toThrow(/Unknown automations.create fields: cwd/);
  await expect(run("automations.run", { id: "a", now: 1 })).rejects.toThrow(
    /Unknown automations.run fields/,
  );
  expect(invoke).not.toHaveBeenCalled();
});

it("keeps a habit run from scheduling", async () => {
  await expect(
    run("automations.list", {}, { isHabitRun: () => true }),
  ).rejects.toThrow(/habit run/);
});
