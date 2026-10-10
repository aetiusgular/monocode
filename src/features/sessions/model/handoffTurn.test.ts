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

  it("leaves both out for a session without them", async () => {
    await requestOutgoingHandoff(base);
    expect(sentTurn()).not.toHaveProperty("extraDirs");
    expect(sentTurn()).not.toHaveProperty("disabledMcpServers");
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
