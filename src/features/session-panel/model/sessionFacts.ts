import { prettyCwd } from "../../../shared/lib/paths";
import {
  contextPercent,
  formatTokens,
} from "../../sessions/model/contextUsage";
import { resolveModel } from "../../sessions/model/models";
import {
  HARNESS_TITLE,
  RUNTIME_MODE_HINT,
  RUNTIME_MODE_LABEL,
  sessionWorkCwd,
  type Session,
} from "../../sessions/model/session";

export type SessionFact = {
  label: string;
  value: string;
  /** The long form, for a tooltip. */
  title?: string;
};

type FactSource = Pick<
  Session,
  | "harness"
  | "model"
  | "runtimeMode"
  | "cwd"
  | "worktreeCwd"
  | "branch"
  | "context"
>;

/** What the session is running on and where, as it stands on the session. */
export function sessionFacts(session: FactSource): SessionFact[] {
  const workCwd = sessionWorkCwd(session);
  const facts: SessionFact[] = [
    { label: "Provider", value: HARNESS_TITLE[session.harness] },
    {
      label: "Model",
      value: resolveModel(session.harness, session.model).name,
      title: session.model,
    },
    {
      label: "Permissions",
      value: RUNTIME_MODE_LABEL[session.runtimeMode],
      title: RUNTIME_MODE_HINT[session.runtimeMode],
    },
    { label: "Working copy", value: prettyCwd(workCwd), title: workCwd },
  ];
  if (session.branch) {
    facts.push({ label: "Branch", value: session.branch });
  }
  const context = session.context;
  if (context) {
    const percent = contextPercent(context);
    const tokens = context.window
      ? `${formatTokens(context.used)} / ${formatTokens(context.window)} tokens`
      : `${formatTokens(context.used)} tokens`;
    facts.push({
      label: "Context",
      value: percent === null ? tokens : `${percent}% · ${tokens}`,
    });
  }
  return facts;
}
