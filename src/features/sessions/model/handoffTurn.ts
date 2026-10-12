import { buildOutgoingHandoffPrompt } from "./handoff";
import {
  cancelHarnessTurn,
  respondHarnessApproval,
  respondHarnessQuestion,
  sendHarnessTurn,
} from "../../../integrations/harness/core/registry";
import { mergeStream } from "../../../integrations/harness/core/streamText";
import type {
  HarnessLaunchMcpServer,
  HarnessToolAccess,
} from "../../../integrations/harness/core/types";
import type { HarnessId } from "./session";

const HANDOFF_TIMEOUT_MS = 45_000;

export async function requestOutgoingHandoff(input: {
  harness: HarnessId;
  sessionId: string;
  cwd: string;
  model: string;
  modelSettings?: Record<string, string>;
  providerAccountId?: string;
  /**
   * The session's composer tools, as its other turns pass them. Claude Code
   * and Codex reopen the conversation when these differ from the turn before,
   * which would hand the outgoing agent a different set of tools to answer
   * with.
   */
  extraDirs?: string[];
  disabledMcpServers?: string[];
  gatewayConnectors?: HarnessLaunchMcpServer[];
  toolAccess?: HarnessToolAccess;
  disabledSkills?: string[];
  disabledPlugins?: string[];
  modelProvider?: string;
  userRequest: string;
}): Promise<string> {
  let brief = "";
  const timer = setTimeout(() => {
    void cancelHarnessTurn(input.harness, input.sessionId);
  }, HANDOFF_TIMEOUT_MS);
  try {
    await sendHarnessTurn({
      harness: input.harness,
      sessionId: input.sessionId,
      cwd: input.cwd,
      model: input.model,
      modelSettings: input.modelSettings,
      providerAccountId: input.providerAccountId,
      runtimeMode: "supervised",
      ...(input.extraDirs ? { extraDirs: input.extraDirs } : {}),
      ...(input.disabledMcpServers
        ? { disabledMcpServers: input.disabledMcpServers }
        : {}),
      ...(input.gatewayConnectors
        ? { gatewayConnectors: input.gatewayConnectors }
        : {}),
      // Blocked tools stay blocked, and are a launch input like the two
      // above. "Always allow" rules are left out: this turn denies every
      // request, and a rule must not let the outgoing agent act instead.
      ...(input.toolAccess?.never?.length
        ? { toolAccess: { never: input.toolAccess.never } }
        : {}),
      ...(input.disabledSkills ? { disabledSkills: input.disabledSkills } : {}),
      ...(input.disabledPlugins
        ? { disabledPlugins: input.disabledPlugins }
        : {}),
      ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
      text: buildOutgoingHandoffPrompt(input.userRequest),
      onEvent: (event) => {
        if (event.type === "message.delta") {
          brief = mergeStream(brief, event.text);
        }
        if (event.type === "approval.requested") {
          respondHarnessApproval(
            input.harness,
            input.sessionId,
            event.requestId,
            "deny",
          );
        }
        if (event.type === "question.asked") {
          respondHarnessQuestion(
            input.harness,
            input.sessionId,
            event.requestId,
            { kind: "skipped" },
          );
        }
      },
    });
  } catch {
    // Caller falls back to the deterministic packet.
  } finally {
    clearTimeout(timer);
  }
  return brief.trim();
}
