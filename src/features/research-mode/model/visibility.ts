import type { HarnessId } from "../../sessions/model/session";
import { harnessCan } from "../../../integrations/harness/core/capabilities";
import { canResearch, type ResearchTool } from "./searchTools";

/** Research mode wraps the prompt for these harnesses only. */
export function harnessSupportsResearch(harness: HarnessId): boolean {
  return harnessCan(harness, "research");
}

/**
 * How the plus menu shows Research: not at all, ready to turn on, or with a
 * note that the chat has no search tool. Host sessions hide it: the host
 * machine builds the prompt and may not know research mode.
 */
export type ResearchMenuState = "hidden" | "ready" | "no-search";

export function researchMenuState(input: {
  harness: HarnessId;
  remote: boolean;
  tools: readonly ResearchTool[];
}): ResearchMenuState {
  if (input.remote || !harnessSupportsResearch(input.harness)) return "hidden";
  return canResearch(input.tools) ? "ready" : "no-search";
}

/**
 * Whether a send goes out as research. A research message needs a search tool
 * and a plain turn: Plan and Orchestrator modes send their own instructions.
 */
export function sendsAsResearch(input: {
  selected: boolean;
  state: ResearchMenuState;
  intent: "default" | "plan" | "orchestrate";
}): boolean {
  return (
    input.selected && input.state === "ready" && input.intent === "default"
  );
}
