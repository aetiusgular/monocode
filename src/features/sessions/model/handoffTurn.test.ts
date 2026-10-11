import { beforeEach, describe, expect, it, vi } from "vitest";

const sendHarnessTurn = vi.hoisted(() => vi.fn());
vi.mock("../../../integrations/harness/core/registry", () => ({
  cancelHarnessTurn: vi.fn(async () => undefined),
  respondHarnessApproval: vi.fn(),
  respondHarnessQuestion: vi.fn(),
  sendHarnessTurn,
}));

import { sessionToolsInput } from "../../session-tools/model/harnessInput";
import { claudeSettingsKey } from "../../../integrations/harness/providers/claude/claudeProtocol";
import type { SendTurnInput } from "../../../integrations/harness/core/types";
import { requestOutgoingHandoff } from "./handoffTurn";

const base = {
  harness: "claude" as const,
  sessionId: "s1",
  cwd: "/repo",
  model: "claude:sonnet",
  userRequest: "continue in Codex",
};

const sentTurn = () => sendHarnessTurn.mock.calls[0][0] as SendTurnInput;

beforeEach(() => {
  sendHarnessTurn.mockReset();
  sendHarnessTurn.mockImplementation(async (input: SendTurnInput) => {
    input.onEvent({ type: "message.delta", text: "The brief." });
  });
});

describe("requestOutgoingHandoff", () => {
  it("sends the helper turn with the session's composer tools", async () => {
    const brief = await requestOutgoingHandoff({
      ...base,
      extraDirs: ["/work/docs"],
      disabledMcpServers: ["github"],
    });
    expect(brief).toBe("The brief.");
    expect(sentTurn()).toMatchObject({
      harness: "claude",
      sessionId: "s1",
      cwd: "/repo",
      runtimeMode: "supervised",
      extraDirs: ["/work/docs"],
      disabledMcpServers: ["github"],
    });
  });

  it("passes the session's Docker gateway connectors on", async () => {
    const gatewayConnectors = [
      {
        name: "linear",
        command: "/usr/local/bin/docker",
        args: ["mcp", "gateway", "run", "--profile", "monocode_linear"],
      },
    ];
    await requestOutgoingHandoff({ ...base, gatewayConnectors });
    expect(sentTurn().gatewayConnectors).toEqual(gatewayConnectors);
    sendHarnessTurn.mockClear();
    await requestOutgoingHandoff(base);
    expect(sentTurn()).not.toHaveProperty("gatewayConnectors");
  });

  it("leaves both out for a session without them", async () => {
    await requestOutgoingHandoff(base);
    expect(sentTurn()).not.toHaveProperty("extraDirs");
    expect(sentTurn()).not.toHaveProperty("disabledMcpServers");
  });

  it("keeps tools blocked but lets no always rule act for the user", async () => {
    await requestOutgoingHandoff({
      ...base,
      toolAccess: { always: ["Bash"], never: ["WebFetch"] },
    });
    // The helper turn denies every request. An always rule would answer
    // before that denial could.
    expect(sentTurn().toolAccess).toEqual({ never: ["WebFetch"] });

    sendHarnessTurn.mockClear();
    await requestOutgoingHandoff({ ...base, toolAccess: { always: ["Bash"] } });
    expect(sentTurn()).not.toHaveProperty("toolAccess");

    // Blocked tools are a launch input: the key matches the turn before.
    const key = (never?: string[]) =>
      claudeSettingsKey({
        model: "sonnet",
        runtimeMode: "supervised",
        deniedTools: never,
      });
    sendHarnessTurn.mockClear();
    await requestOutgoingHandoff({
      ...base,
      toolAccess: { always: ["Bash"], never: ["WebFetch"] },
    });
    expect(key(sentTurn().toolAccess?.never)).toBe(key(["WebFetch"]));
  });

  it("sends the skills switched off for the chat, a launch input too", async () => {
    const tools = sessionToolsInput(
      { harness: "claude", disabledSkills: ["deploy"] },
      "/repo",
    );
    await requestOutgoingHandoff({ ...base, ...tools });
    expect(sentTurn().disabledSkills).toEqual(["deploy"]);
    const key = (disabledSkills?: string[]) =>
      claudeSettingsKey({
        model: "sonnet",
        runtimeMode: "supervised",
        disabledSkills,
      });
    expect(key(sentTurn().disabledSkills)).toBe(key(["deploy"]));

    sendHarnessTurn.mockClear();
    await requestOutgoingHandoff(base);
    expect(sentTurn()).not.toHaveProperty("disabledSkills");
  });

  it("sends the plugins switched off for the chat, a launch input too", async () => {
    const tools = sessionToolsInput(
      { harness: "claude", disabledPlugins: ["paper-desktop@paper"] },
      "/repo",
    );
    await requestOutgoingHandoff({ ...base, ...tools });
    expect(sentTurn().disabledPlugins).toEqual(["paper-desktop@paper"]);

    sendHarnessTurn.mockClear();
    await requestOutgoingHandoff(base);
    expect(sentTurn()).not.toHaveProperty("disabledPlugins");
  });

  it("launches Claude Code with the tools its turn before had", async () => {
    // A model switch has already renamed the session's harness, so the tools
    // are worked out for the outgoing one.
    const session = {
      harness: "cursor" as const,
      extraDirs: ["/work/docs", "/repo/packages"],
      disabledMcpServers: ["github"],
    };
    const tools = sessionToolsInput({ ...session, harness: "claude" }, "/repo");
    expect(tools).toEqual({
      extraDirs: ["/work/docs"],
      disabledMcpServers: ["github"],
    });
    expect(sessionToolsInput(session, "/repo")).toEqual({});

    await requestOutgoingHandoff({ ...base, ...tools });
    const key = (input: {
      extraDirs?: string[];
      disabledMcpServers?: string[];
    }) =>
      claudeSettingsKey({
        model: "sonnet",
        runtimeMode: "supervised",
        extraDirs: input.extraDirs,
        disabledMcpServers: input.disabledMcpServers,
      });
    expect(key(sentTurn())).toBe(key(tools));
    expect(key(sentTurn())).not.toBe(key({}));
  });
});
