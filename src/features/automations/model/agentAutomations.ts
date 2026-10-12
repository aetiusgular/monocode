import { looksLikeProject } from "../../projects/model/recents";
import type { RuntimeMode, Session } from "../../sessions/model/session";
import { RUNTIME_MODES } from "../../sessions/model/session";
import {
  AUTOMATION_WEEKDAYS,
  INTERVAL_MINUTES_MAX,
  INTERVAL_MINUTES_MIN,
  automationScheduleLabel,
  automationTriggers,
  createAutomationTrigger,
  joinLocalMoment,
  listAutomations,
  type Automation,
  type AutomationTrigger,
} from "./automations";
import {
  PROPOSAL_NAME_MAX,
  PROPOSAL_PROMPT_MAX,
  loadAutomationProposals,
  proposeAutomation,
  type AutomationProposal,
} from "./automationProposals";

/**
 * `automations.*` app actions for a thread with operator access (#39).
 * Listing and running an automation the user already saved happen at once.
 * Creating, changing and removing one become proposals that wait for the
 * user's click, because an automation runs prompts unattended.
 */

export const SCHEDULE_HELP =
  'schedule is one of: "hourly :15", "daily 09:00", "weekdays 09:00", "weekly monday 09:00", "once 2026-10-14 09:00", "every 30m", "every 2h". Times are the user\'s local time.';

/**
 * Parse a schedule an agent wrote as plain text. Text, not JSON fields,
 * because a small model gets a sentence right more often (rule 4).
 */
export function parseScheduleText(
  text: string,
  now = Date.now(),
): AutomationTrigger | string {
  const words = text
    .trim()
    .toLowerCase()
    .replace(/\bat\b/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const [kind, ...rest] = words;
  const clock = (value: string | undefined) =>
    value && /^\d{1,2}:\d{2}$/.test(value) ? value.padStart(5, "0") : undefined;
  const validClock = (value: string | undefined) => {
    const c = clock(value);
    if (!c) return undefined;
    const [h, m] = c.split(":").map(Number);
    return h! < 24 && m! < 60 ? c : undefined;
  };
  switch (kind) {
    case "hourly": {
      const minute = rest[0] ? Number(rest[0].replace(/^:/, "")) : 0;
      if (
        rest.length > 1 ||
        !Number.isInteger(minute) ||
        minute < 0 ||
        minute > 59
      )
        return `Could not read "${text}". ${SCHEDULE_HELP}`;
      return createAutomationTrigger("time", "hourly", { minute });
    }
    case "daily":
    case "weekdays": {
      const time = validClock(rest[0]);
      if (!time || rest.length !== 1)
        return `Could not read "${text}". ${SCHEDULE_HELP}`;
      return createAutomationTrigger("time", kind, { time });
    }
    case "weekly": {
      const day = AUTOMATION_WEEKDAYS.findIndex((name) =>
        rest[0] ? name.toLowerCase().startsWith(rest[0].slice(0, 3)) : false,
      );
      const time = validClock(rest[1]);
      if (day < 0 || !time || rest.length !== 2 || (rest[0]?.length ?? 0) < 3)
        return `Could not read "${text}". ${SCHEDULE_HELP}`;
      return createAutomationTrigger("time", "weekly", {
        dayOfWeek: day,
        time,
      });
    }
    case "once": {
      const time = validClock(rest[1]);
      const at = rest[0] && time ? joinLocalMoment(rest[0], time) : null;
      if (at == null || rest.length !== 2)
        return `Could not read "${text}". ${SCHEDULE_HELP}`;
      if (at <= now) return `${rest[0]} ${time} has already passed.`;
      return createAutomationTrigger("time", "once", { at, time });
    }
    case "every": {
      const joined = rest.join("");
      const match =
        /^(\d+)(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/.exec(
          joined,
        );
      if (!match) return `Could not read "${text}". ${SCHEDULE_HELP}`;
      const n = Number(match[1]);
      const unit = match[2]![0];
      const minutes = unit === "d" ? n * 1440 : unit === "h" ? n * 60 : n;
      if (minutes < INTERVAL_MINUTES_MIN || minutes > INTERVAL_MINUTES_MAX)
        return "An interval must be between 5 minutes and 30 days.";
      return createAutomationTrigger("time", "interval", {
        intervalMinutes: minutes,
      });
    }
    default:
      return `Could not read "${text}". ${SCHEDULE_HELP}`;
  }
}

export type AutomationActionHost = {
  /** Start a manual run of a saved automation now. */
  runAutomation?(automationId: string): Promise<void>;
  isHabitRun?(sessionId: string): boolean;
  now?(): Date;
};

export type AutomationActionDeps = {
  list: () => Promise<Automation[]>;
  propose: typeof proposeAutomation;
  waiting: (project: string) => Promise<AutomationProposal[]>;
};

const DEPS: AutomationActionDeps = {
  list: listAutomations,
  propose: proposeAutomation,
  waiting: loadAutomationProposals,
};

const WAITING_NOTE =
  "Nothing is saved yet. The user accepts or dismisses it on the Automations page. Tell them it is waiting there.";

function text(
  input: Record<string, unknown>,
  key: string,
  max: number,
  required: boolean,
): string | undefined {
  const value = input[key];
  if (value == null) {
    if (required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${key} must be text`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (trimmed.length > max)
    throw new Error(`${key} is too long (at most ${max} characters)`);
  return trimmed;
}

function bool(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (value == null) return undefined;
  if (typeof value !== "boolean")
    throw new Error(`${key} must be true or false`);
  return value;
}

const MODE_RANK: Record<RuntimeMode, number> = {
  supervised: 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

/**
 * Whether an agent in a chat with `caller` mode may start an automation saved
 * with `target` mode. Only Supervised and Auto-accept edits runs, and never a
 * mode wider than the caller's.
 */
export function agentMayRunInMode(
  target: RuntimeMode,
  caller: RuntimeMode | undefined,
): boolean {
  if (target === "auto" || target === "full-access") return false;
  const callerRank = MODE_RANK[caller ?? "supervised"] ?? 0;
  return (MODE_RANK[target] ?? 99) <= callerRank;
}

function runtimeMode(input: Record<string, unknown>): RuntimeMode | undefined {
  const value = input.runtimeMode;
  if (value == null) return undefined;
  if (!RUNTIME_MODES.includes(value as RuntimeMode))
    throw new Error(`runtimeMode must be one of: ${RUNTIME_MODES.join(", ")}`);
  return value as RuntimeMode;
}

function workspaceMode(input: Record<string, unknown>) {
  const value = input.workspaceMode;
  if (value == null) return undefined;
  if (value !== "current" && value !== "worktree")
    throw new Error('workspaceMode must be "current" or "worktree"');
  return value;
}

function schedule(
  input: Record<string, unknown>,
  required: boolean,
  now: number,
): { schedule: string; trigger: AutomationTrigger } | undefined {
  const raw = text(input, "schedule", 200, required);
  if (!raw) return undefined;
  const parsed = parseScheduleText(raw, now);
  if (typeof parsed === "string") throw new Error(parsed);
  return { schedule: raw, trigger: parsed };
}

function summary(automation: Automation) {
  const triggers = automationTriggers(automation);
  return {
    id: automation.id,
    name: automation.name,
    enabled: automation.enabled,
    schedule: triggers
      .map((trigger) =>
        trigger.kind === "time"
          ? automationScheduleLabel(trigger)
          : `${trigger.kind} ${trigger.event}`,
      )
      .join("; "),
    runtimeMode: automation.runtimeMode,
    ...(automation.lastRunStatus ? { lastRun: automation.lastRunStatus } : {}),
  };
}

function ownAutomation(
  automations: Automation[],
  project: string,
  input: Record<string, unknown>,
): Automation {
  const id = text(input, "id", 128, true)!;
  const found = automations.find(
    (automation) => automation.id === id && automation.cwd === project,
  );
  if (!found)
    throw new Error(
      "No automation with that id in this project. Use automations.list.",
    );
  return found;
}

export async function handleAutomationAction(
  source: Session,
  action: string,
  input: Record<string, unknown>,
  host: AutomationActionHost,
  deps: AutomationActionDeps = DEPS,
): Promise<unknown> {
  if (host.isHabitRun?.(source.id))
    throw new Error("A habit run may remember, not schedule.");
  const project = source.cwd;
  if (!looksLikeProject(project))
    throw new Error("Automations belong to a project; this thread has none.");
  const now = host.now?.().getTime() ?? Date.now();
  switch (action) {
    case "automations.list": {
      const automations = (await deps.list()).filter(
        (automation) => automation.cwd === project,
      );
      const waiting = await deps.waiting(project);
      return {
        automations: automations.map(summary),
        waitingForUser: waiting.length,
      };
    }
    case "automations.create": {
      const name = text(input, "name", PROPOSAL_NAME_MAX, true)!;
      const prompt = text(input, "prompt", PROPOSAL_PROMPT_MAX, true)!;
      const when = schedule(input, true, now)!;
      const proposal = await deps.propose(
        {
          kind: "create",
          project,
          name,
          prompt,
          ...when,
          runtimeMode: runtimeMode(input) ?? source.runtimeMode,
          ...(workspaceMode(input)
            ? { workspaceMode: workspaceMode(input)! }
            : {}),
          ...(bool(input, "keepAwake") != null
            ? { keepAwake: bool(input, "keepAwake")! }
            : {}),
          harness: source.harness,
          model: source.model,
          sessionId: source.id,
        },
        now,
      );
      return {
        waiting: true,
        proposalId: proposal.id,
        schedule: automationScheduleLabel(when.trigger),
        note: WAITING_NOTE,
      };
    }
    case "automations.update": {
      const existing = ownAutomation(await deps.list(), project, input);
      const name = text(input, "name", PROPOSAL_NAME_MAX, false);
      const prompt = text(input, "prompt", PROPOSAL_PROMPT_MAX, false);
      const when = schedule(input, false, now);
      const mode = runtimeMode(input);
      const workspace = workspaceMode(input);
      const keepAwake = bool(input, "keepAwake");
      const enabled = bool(input, "enabled");
      if (
        name == null &&
        prompt == null &&
        !when &&
        !mode &&
        !workspace &&
        keepAwake == null &&
        enabled == null
      )
        throw new Error("Nothing to change.");
      const proposal = await deps.propose(
        {
          kind: "update",
          project,
          automationId: existing.id,
          currentName: existing.name,
          ...(name != null ? { name } : {}),
          ...(prompt != null ? { prompt } : {}),
          ...(when ?? {}),
          ...(mode ? { runtimeMode: mode } : {}),
          ...(workspace ? { workspaceMode: workspace } : {}),
          ...(keepAwake != null ? { keepAwake } : {}),
          ...(enabled != null ? { enabled } : {}),
          sessionId: source.id,
        },
        now,
      );
      return { waiting: true, proposalId: proposal.id, note: WAITING_NOTE };
    }
    case "automations.remove": {
      const existing = ownAutomation(await deps.list(), project, input);
      const proposal = await deps.propose(
        {
          kind: "remove",
          project,
          automationId: existing.id,
          currentName: existing.name,
          sessionId: source.id,
        },
        now,
      );
      return { waiting: true, proposalId: proposal.id, note: WAITING_NOTE };
    }
    case "automations.run": {
      const existing = ownAutomation(await deps.list(), project, input);
      // One at a time: text the agent read cannot make it loop runs.
      if (
        existing.lastRunStatus === "pending" ||
        existing.lastRunStatus === "running"
      )
        throw new Error("That automation is already running.");
      // An agent may start a run only in a mode no wider than its own chat's,
      // and never in Auto or Full access: text it read must not raise its own
      // access through a saved automation (security review, finding F2).
      if (!agentMayRunInMode(existing.runtimeMode, source.runtimeMode))
        throw new Error(
          `That automation runs in ${existing.runtimeMode}, which an agent cannot start from a ${source.runtimeMode} chat. Ask the user to start it with Run now on the Automations page.`,
        );
      if (!host.runAutomation)
        throw new Error("Automations cannot be run from this window.");
      await host.runAutomation(existing.id);
      return {
        started: true,
        name: existing.name,
        note: "It runs in its own session with its own permission mode. Its result shows in the Automations page's run history.",
      };
    }
    default:
      throw new Error(`Unknown app action: ${action}`);
  }
}
