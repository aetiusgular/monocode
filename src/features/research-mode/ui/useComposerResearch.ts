import { useCallback, useState } from "react";
import { openConnectorsPage } from "../../gateway-connectors/model/navigation";
import type { HarnessId, ToolAccess } from "../../sessions/model/session";
import {
  researchReportPath,
  type ResearchRequest,
} from "../model/researchPrompt";
import { researchRequest } from "../model/searchTools";
import {
  researchMenuState,
  sendsAsResearch,
  type ResearchMenuState,
} from "../model/visibility";
import { useResearchTools } from "./useResearchTools";

export type ComposerResearch = {
  state: ResearchMenuState;
  /** Research is on for the next message and the chat can show it. */
  active: boolean;
  setSelected: (on: boolean) => void;
  clear: () => void;
  openConnectors: () => void;
  /**
   * What a send carries. `blocked` stops a send that was meant as research
   * while the chat has no search tool, so it does not go out as a plain
   * prompt the user did not ask for.
   */
  forSend: (
    intent: "default" | "plan" | "orchestrate",
    question: string,
  ) => { request?: ResearchRequest; blocked: boolean };
};

/** The composer's research toggle: per message, never saved with the chat. */
export function useComposerResearch(input: {
  harness: HarnessId;
  cwd: string;
  sessionId?: string;
  providerAccountId?: string;
  disabledMcpServers?: readonly string[];
  toolAccess?: ToolAccess;
  remote: boolean;
  plusOpen: boolean;
}): ComposerResearch {
  const [selected, setSelected] = useState(false);
  const tools = useResearchTools({
    harness: input.harness,
    cwd: input.cwd,
    sessionId: input.sessionId,
    providerAccountId: input.providerAccountId,
    disabledMcpServers: input.disabledMcpServers,
    toolAccess: input.toolAccess,
    remote: input.remote,
    load: input.plusOpen || selected,
  });
  const state = researchMenuState({
    harness: input.harness,
    remote: input.remote,
    tools,
  });
  const active = selected && state !== "hidden";
  const clear = useCallback(() => setSelected(false), []);
  const openConnectors = useCallback(() => openConnectorsPage("discover"), []);
  const forSend = (
    intent: "default" | "plan" | "orchestrate",
    question: string,
  ) => {
    if (!active || intent !== "default") return { blocked: false };
    if (!sendsAsResearch({ selected, state, intent })) return { blocked: true };
    const request = researchRequest(
      tools,
      { harness: input.harness, toolAccess: input.toolAccess },
      researchReportPath(question),
    );
    return request ? { request, blocked: false } : { blocked: true };
  };
  return { state, active, setSelected, clear, openConnectors, forSend };
}
