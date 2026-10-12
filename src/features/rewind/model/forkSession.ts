import type { HarnessSessionInput } from "../../../integrations/harness/core/types";
import {
  appendReadyHandoff,
  buildDeterministicHandoff,
} from "../../sessions/model/handoff";
import type { Session } from "../../sessions/model/session";
import {
  forkBlocks,
  forkTitle,
  type RewindOptions,
} from "./rewind";

export type NativeFork = (input: {
  source: HarnessSessionInput;
  providerSessionId: string;
  newSessionId: string;
  boundary?: string;
}) => Promise<{ providerSessionId?: string }>;

export type ForkResult = {
  session: Session;
  approximate: boolean;
  /** Why the fork is approximate: the plan's reason or the native error. */
  reason?: string;
};

/**
 * Builds the new chat for a fork at `options`. `base` is a fresh session with
 * the source's harness, model, folder and account. Native when the plan says
 * so and the harness call works; otherwise the transcript up to the end of
 * the turn goes to a new conversation as a handoff, and the chat says it is
 * approximate. The source chat is never changed.
 */
export async function forkSessionAt(input: {
  source: Session;
  options: RewindOptions;
  base: Session;
  sourceInput: HarnessSessionInput;
  nativeFork: NativeFork;
}): Promise<ForkResult> {
  const { source, options, base } = input;
  const blocks = forkBlocks(source, options.turnEnd);
  const plan = options.fork.plan;
  if (plan.mode === "native" && source.providerSessionId) {
    try {
      const boundary = plan.harness === "codex" ? plan.lastTurnId : plan.at;
      const made = await input.nativeFork({
        source: input.sourceInput,
        providerSessionId: source.providerSessionId,
        newSessionId: base.id,
        ...(boundary ? { boundary } : {}),
      });
      return {
        approximate: false,
        session: {
          ...base,
          blocks,
          title: forkTitle(source.title, false),
          ...(made.providerSessionId
            ? { providerSessionId: made.providerSessionId }
            : {}),
        },
      };
    } catch (error) {
      return approximateFork(
        source,
        options,
        base,
        blocks,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return approximateFork(
    source,
    options,
    base,
    blocks,
    plan.mode === "approximate" ? plan.reason : "No conversation to copy",
  );
}

function approximateFork(
  source: Session,
  options: RewindOptions,
  base: Session,
  blocks: Session["blocks"],
  reason: string,
): ForkResult {
  // The recap reads only the turns the fork keeps.
  const through = { ...source, blocks: source.blocks.slice(0, options.turnEnd) };
  const recap = buildDeterministicHandoff(through, undefined, base.cwd);
  const notice = {
    id: crypto.randomUUID(),
    role: "system" as const,
    text: `Approximate fork: ${reason.replace(/\.$/, "")}. The agent gets a recap of the transcript above, not its original context.`,
  };
  const seeded = appendReadyHandoff(
    { ...base, blocks: [...blocks, notice] },
    source.harness,
    source.harness,
    recap,
  );
  return {
    approximate: true,
    reason,
    session: {
      ...seeded,
      title: forkTitle(source.title, true),
      providerSessionId: undefined,
    },
  };
}
