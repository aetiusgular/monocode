import { describe, expect, it } from "vitest";
import { newChatLike as newChatLike_s6 } from "./newChatLike";
import type { Session } from "../../sessions/model/session";

// Security review W2: "New chat with these" carried the harness, model, mode
// and account but dropped every switch that narrows the chat, so a connector
// or tool the user switched off came back on, and it took the project's
// focused checkout instead of the chat's own.

function source(extra: Partial<Session> = {}): Session {
  return {
    id: "src",
    harness: "codex",
    model: "gpt-5.2-codex",
    modelSettings: {},
    runtimeMode: "supervised",
    title: "codex",
    cwd: "/Users/tonyg/proj",
    blocks: [
      {
        id: "u1",
        role: "user",
        text: "hi",
      } as unknown as Session["blocks"][number],
    ],
    providerSessionId: "thread-1",
    providerAccountId: "local",
    modelProvider: "ollama_local",
    worktreeCwd: "/Users/tonyg/proj-wt",
    branch: "feature",
    extraDirs: ["/Users/tonyg/other"],
    disabledMcpServers: ["exa"],
    disabledSkills: ["deploy"],
    disabledPlugins: ["git@market"],
    gatewayOn: ["github"],
    permissionsProfile: "readonly",
    toolAccess: {
      Bash: "always",
      "codex:command": "never",
      mcp__exa__web_search: "never",
      Write: "always",
    },
    ...extra,
  };
}

describe("newChatLike", () => {
  it("carries every switch that narrows the chat", () => {
    const next = newChatLike_s6(source());
    expect(next.harness).toBe("codex");
    expect(next.cwd).toBe("/Users/tonyg/proj");
    expect(next.runtimeMode).toBe("supervised");
    expect(next.providerAccountId).toBe("local");
    expect(next.modelProvider).toBe("ollama_local");
    expect(next.disabledMcpServers).toEqual(["exa"]);
    expect(next.disabledSkills).toEqual(["deploy"]);
    expect(next.disabledPlugins).toEqual(["git@market"]);
    expect(next.gatewayOn).toEqual(["github"]);
    expect(next.permissionsProfile).toBe("readonly");
  });

  it("keeps never rules and drops always rules", () => {
    const next = newChatLike_s6(source());
    expect(next.toolAccess).toEqual({
      "codex:command": "never",
      mcp__exa__web_search: "never",
    });
  });

  it("carries no tool rules when the source has only always rules", () => {
    const next = newChatLike_s6(source({ toolAccess: { Bash: "always" } }));
    expect(next.toolAccess).toBeUndefined();
  });

  it("keeps an empty gateway list, which means every connector off", () => {
    const next = newChatLike_s6(source({ gatewayOn: [] }));
    expect(next.gatewayOn).toEqual([]);
  });

  it("uses the source chat's own checkout", () => {
    const next = newChatLike_s6(source());
    expect(next.worktreeCwd).toBe("/Users/tonyg/proj-wt");
    expect(next.branch).toBe("feature");
  });

  it("does not carry a removed checkout", () => {
    const next = newChatLike_s6(source({ worktreeRemoved: true }));
    expect(next.worktreeCwd).toBeUndefined();
  });

  it("carries nothing that widens or belongs to the old conversation", () => {
    const next = newChatLike_s6(source());
    expect(next.id).not.toBe("src");
    expect(next.extraDirs).toBeUndefined();
    expect(next.providerSessionId).toBeUndefined();
    expect(next.blocks).toEqual([]);
  });

  it("does not share arrays with the source", () => {
    const from = source();
    const next = newChatLike_s6(from);
    next.disabledMcpServers!.push("x");
    next.gatewayOn!.push("y");
    expect(from.disabledMcpServers).toEqual(["exa"]);
    expect(from.gatewayOn).toEqual(["github"]);
  });
});
