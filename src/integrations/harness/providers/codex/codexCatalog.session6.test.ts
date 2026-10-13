import { describe, expect, it, vi } from "vitest";
import type { AgentModel } from "../../../../features/sessions/model/models";

vi.mock("../../../../platform/tauri/fs", () => ({ homeDir: async () => "/home/u" }));
vi.mock("../../core/child", () => ({
  killChild: vi.fn(),
  resolveCodexBinary: vi.fn(),
  spawnChild: vi.fn(),
  unwatchChild: vi.fn(),
  watchChild: vi.fn(),
}));

import { discoverCodexModelsForAccounts } from "./codexCatalog";

const model = (nativeId: string): AgentModel => ({
  id: `codex:${nativeId}`,
  harness: "codex",
  name: nativeId,
  nativeId,
});

// Mac finding 5.3: a Codex account written by model setup listed no models,
// because only the default home was asked, and it needs an OpenAI sign-in.
describe("Codex models from every account home", () => {
  it("lists a named local account's model when the default home refuses", async () => {
    const discover = vi.fn(async (_cwd?: string, account?: string) => {
      if (!account) throw new Error("Codex CLI is not authenticated.");
      return [model("qwen3:8b")];
    });
    const models = await discoverCodexModelsForAccounts(["account-local"], discover);
    expect(models.map((m) => m.nativeId)).toEqual(["qwen3:8b"]);
    expect(discover).toHaveBeenCalledWith(undefined, undefined);
    expect(discover).toHaveBeenCalledWith(undefined, "account-local");
  });

  it("keeps the default home first and lists a shared model once", async () => {
    const discover = async (_cwd?: string, account?: string) =>
      account ? [model("qwen3:8b"), model("gpt-5.6")] : [model("gpt-5.6"), model("o9")];
    const models = await discoverCodexModelsForAccounts(["a"], discover);
    expect(models.map((m) => m.nativeId)).toEqual(["gpt-5.6", "o9", "qwen3:8b"]);
  });

  it("asks only the default home when there is no named account", async () => {
    const discover = vi.fn(async () => [model("gpt-5.6")]);
    await discoverCodexModelsForAccounts([], discover);
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it("throws the first error only when every home failed", async () => {
    const discover = async (_cwd?: string, account?: string) => {
      throw new Error(account ? "account failed" : "default failed");
    };
    await expect(discoverCodexModelsForAccounts(["a"], discover)).rejects.toThrow(
      "default failed",
    );
  });

  it("one slow or broken home does not hide the others (corner case 6)", async () => {
    const discover = async (_cwd?: string, account?: string) => {
      if (account === "broken") throw new Error("Codex model discovery timed out");
      return [model(account ?? "default-model")];
    };
    const models = await discoverCodexModelsForAccounts(["broken", "ok"], discover);
    expect(models.map((m) => m.nativeId)).toEqual(["default-model", "ok"]);
  });
});
