import {
  editProjectContext,
  readProjectContext,
} from "../../project-context/model/projectContext";
import type { HarnessId, RuntimeMode } from "../../sessions/model/session";
import { RUNTIME_MODES } from "../../sessions/model/session";
import {
  applyTriggers,
  deleteAutomation,
  draftFromAutomation,
  listAutomations,
  newAutomationDraft,
  saveAutomation,
  type Automation,
  type AutomationTrigger,
  type AutomationWorkspaceMode,
} from "./automations";

/**
 * Automation changes an agent asked for (#39), waiting for the user's click.
 * An automation runs prompts unattended in its own permission mode, so an
 * agent never saves, changes or removes one itself (rules, security item 5).
 * The app CLI times out after 35 seconds, so the agent is answered at once
 * and the decision comes later, on the Automations page.
 *
 * Stored per project in the app's data folder (`automation-proposals.json`),
 * beside the memory proposals, so they survive a reload.
 */
export type AutomationProposal = {
  id: string;
  kind: "create" | "update" | "remove";
  /** The project the asking session works in. */
  project: string;
  /** For update and remove. */
  automationId?: string;
  /** The automation's name when the proposal was made, for remove. */
  currentName?: string;
  name?: string;
  prompt?: string;
  /** The schedule as the agent wrote it, and as parsed. */
  schedule?: string;
  trigger?: AutomationTrigger;
  runtimeMode?: RuntimeMode;
  workspaceMode?: AutomationWorkspaceMode;
  keepAwake?: boolean;
  enabled?: boolean;
  /** A new automation runs on the asking session's harness and model. */
  harness?: HarnessId;
  model?: string;
  sessionId?: string;
  at: number;
};

export const AUTOMATION_PROPOSALS_MAX = 20;
export const PROPOSAL_PROMPT_MAX = 20_000;
export const PROPOSAL_NAME_MAX = 200;
const FILE = "automation-proposals.json";

function str(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

function parseTrigger(value: unknown): AutomationTrigger | undefined {
  if (!value || typeof value !== "object") return undefined;
  const t = value as Record<string, unknown>;
  if (t.kind !== "time") return undefined;
  const scheduleKind = t.scheduleKind;
  if (
    scheduleKind !== "hourly" &&
    scheduleKind !== "daily" &&
    scheduleKind !== "weekdays" &&
    scheduleKind !== "weekly" &&
    scheduleKind !== "once" &&
    scheduleKind !== "interval"
  )
    return undefined;
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    id: str(t.id, 80) ?? "",
    kind: "time",
    event: scheduleKind,
    scheduleKind,
    minute: num(t.minute, 0),
    time: str(t.time, 5) ?? "09:00",
    dayOfWeek: num(t.dayOfWeek, 1),
    repos: [],
    repo: "",
    branch: "",
    actor: "anyone",
    ...(scheduleKind === "once" ? { at: num(t.at, 0) } : {}),
    ...(scheduleKind === "interval"
      ? { intervalMinutes: num(t.intervalMinutes, 60) }
      : {}),
  };
}

/** Loose, bounded parse: anything malformed is dropped, never trusted. */
export function parseAutomationProposals(
  text: string | null,
): AutomationProposal[] {
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .flatMap((value): AutomationProposal[] => {
        if (!value || typeof value !== "object") return [];
        const item = value as Record<string, unknown>;
        const kind = item.kind;
        if (kind !== "create" && kind !== "update" && kind !== "remove")
          return [];
        const id = str(item.id, 64);
        const project = str(item.project, 4096);
        if (!id || !project) return [];
        const automationId = str(item.automationId, 128);
        if (kind !== "create" && !automationId) return [];
        const trigger = parseTrigger(item.trigger);
        const runtimeMode = RUNTIME_MODES.includes(item.runtimeMode as never)
          ? (item.runtimeMode as RuntimeMode)
          : undefined;
        const workspaceMode =
          item.workspaceMode === "current" || item.workspaceMode === "worktree"
            ? item.workspaceMode
            : undefined;
        const proposal: AutomationProposal = {
          id,
          kind,
          project,
          ...(automationId ? { automationId } : {}),
          ...(str(item.currentName, PROPOSAL_NAME_MAX)
            ? { currentName: item.currentName as string }
            : {}),
          ...(str(item.name, PROPOSAL_NAME_MAX)
            ? { name: item.name as string }
            : {}),
          ...(str(item.prompt, PROPOSAL_PROMPT_MAX)
            ? { prompt: item.prompt as string }
            : {}),
          ...(str(item.schedule, 200)
            ? { schedule: item.schedule as string }
            : {}),
          ...(trigger ? { trigger } : {}),
          ...(runtimeMode ? { runtimeMode } : {}),
          ...(workspaceMode ? { workspaceMode } : {}),
          ...(typeof item.keepAwake === "boolean"
            ? { keepAwake: item.keepAwake }
            : {}),
          ...(typeof item.enabled === "boolean"
            ? { enabled: item.enabled }
            : {}),
          ...(str(item.harness, 40)
            ? { harness: item.harness as HarnessId }
            : {}),
          ...(str(item.model, 400) ? { model: item.model as string } : {}),
          ...(str(item.sessionId, 256)
            ? { sessionId: item.sessionId as string }
            : {}),
          at: typeof item.at === "number" ? item.at : 0,
        };
        // A create needs everything it will run with.
        if (
          kind === "create" &&
          (!proposal.name ||
            !proposal.prompt ||
            !proposal.trigger ||
            !proposal.harness ||
            proposal.model == null)
        )
          return [];
        return [proposal];
      })
      .slice(-AUTOMATION_PROPOSALS_MAX);
  } catch {
    return [];
  }
}

function serialize(list: AutomationProposal[]): string {
  return `${JSON.stringify(list, null, 2)}\n`;
}

let counter = 0;
function proposalId(now: number): string {
  counter = (counter + 1) % 1_000_000;
  return `a${now.toString(36)}${counter.toString(36)}`;
}

export async function loadAutomationProposals(
  project: string,
): Promise<AutomationProposal[]> {
  return parseAutomationProposals(
    (await readProjectContext(project, FILE)).text,
  );
}

export class ProposalsFull extends Error {
  constructor() {
    super(
      `${AUTOMATION_PROPOSALS_MAX} automation changes are already waiting for the user. Ask them to review the Automations page first.`,
    );
  }
}

/** Store one proposal. Refuses past the cap instead of dropping the oldest. */
export async function proposeAutomation(
  proposal: Omit<AutomationProposal, "id" | "at">,
  now = Date.now(),
): Promise<AutomationProposal> {
  return editProjectContext(proposal.project, FILE, (text) => {
    const list = parseAutomationProposals(text);
    if (list.length >= AUTOMATION_PROPOSALS_MAX) throw new ProposalsFull();
    const added: AutomationProposal = {
      ...proposal,
      id: proposalId(now),
      at: now,
    };
    list.push(added);
    return { text: serialize(list), result: added };
  });
}

async function take(
  project: string,
  id: string,
): Promise<AutomationProposal | undefined> {
  return editProjectContext(project, FILE, (text) => {
    const list = parseAutomationProposals(text);
    const found = list.find((item) => item.id === id);
    return {
      text: found
        ? serialize(list.filter((item) => item.id !== id))
        : (text ?? ""),
      result: found,
    };
  });
}

export async function dismissAutomationProposal(
  project: string,
  id: string,
): Promise<void> {
  await take(project, id);
}

type Store = {
  list: () => Promise<Automation[]>;
  save: typeof saveAutomation;
  remove: (id: string) => Promise<void>;
};

const STORE: Store = {
  list: listAutomations,
  save: saveAutomation,
  remove: deleteAutomation,
};

/**
 * What accepting does. Pure, so the card can show it and tests can check it.
 * Returns null for a remove.
 */
export function proposalDraft(
  proposal: AutomationProposal,
  existing: Automation | undefined,
) {
  if (proposal.kind === "remove") return null;
  if (proposal.kind === "update" && !existing)
    throw new Error("That automation no longer exists.");
  let draft =
    proposal.kind === "update" && existing
      ? draftFromAutomation(existing)
      : newAutomationDraft(
          proposal.project,
          proposal.harness ?? "claude",
          proposal.model ?? "",
        );
  if (proposal.name != null) draft = { ...draft, name: proposal.name };
  if (proposal.prompt != null) draft = { ...draft, prompt: proposal.prompt };
  if (proposal.runtimeMode)
    draft = { ...draft, runtimeMode: proposal.runtimeMode };
  if (proposal.workspaceMode)
    draft = { ...draft, workspaceMode: proposal.workspaceMode };
  if (proposal.keepAwake != null)
    draft = { ...draft, keepAwake: proposal.keepAwake };
  if (proposal.enabled != null) draft = { ...draft, enabled: proposal.enabled };
  if (proposal.trigger) {
    // A new schedule replaces the time triggers and keeps any event triggers.
    const events = draft.triggers.filter((trigger) => trigger.kind !== "time");
    const trigger = {
      ...proposal.trigger,
      id: proposal.trigger.id || crypto.randomUUID(),
    };
    draft = applyTriggers(draft, [trigger, ...events]);
  }
  return draft;
}

/** The user accepted: apply it, then drop the proposal. */
export async function acceptAutomationProposal(
  project: string,
  id: string,
  store: Store = STORE,
): Promise<Automation | null> {
  const proposal = (await loadAutomationProposals(project)).find(
    (item) => item.id === id,
  );
  if (!proposal) throw new Error("That change is no longer waiting.");
  const existing = proposal.automationId
    ? (await store.list()).find((item) => item.id === proposal.automationId)
    : undefined;
  if (proposal.kind === "remove") {
    if (existing) await store.remove(existing.id);
    await take(project, id);
    return null;
  }
  const draft = proposalDraft(proposal, existing);
  // Save first: a refused save (a one-time run in the past) keeps the card.
  const saved = await store.save(draft!);
  await take(project, id);
  return saved;
}
