import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { HarnessId, RuntimeMode } from "../../sessions/model/session";

export const AUTOMATIONS_CHANGED = "monocode:automations-changed";
const LOCAL_CHANGED = "monocode:automations-local-changed";

export type AutomationWorkspaceMode = "current" | "worktree" | "existing";
export type AutomationScheduleKind =
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  /** One run at `at`; the automation turns itself off after it fires. */
  | "once"
  /** Every `intervalMinutes`, from the last run. */
  | "interval";
export type AutomationTriggerKind =
  "time" | "github" | "linear" | "jira" | "gitlab" | "azuredevops";

export type AutomationTrigger = {
  id: string;
  kind: AutomationTriggerKind;
  event: string;
  scheduleKind: AutomationScheduleKind;
  minute: number;
  time: string;
  dayOfWeek: number;
  repos: string[];
  repo: string;
  branch: string;
  actor: string;
  /** A one-time schedule's moment, epoch ms. */
  at?: number;
  /** An interval schedule's period, 5 minutes to 30 days. */
  intervalMinutes?: number;
};

export const INTERVAL_MINUTES_MIN = 5;
export const INTERVAL_MINUTES_MAX = 43_200;

export type AutomationRunStatus =
  "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export type Automation = {
  id: string;
  name: string;
  prompt: string;
  harness: HarnessId;
  model: string;
  modelSettings?: Record<string, string>;
  cwd: string;
  workspaceMode: AutomationWorkspaceMode;
  worktreeCwd?: string;
  sessionFolderId?: string;
  reuseSession: boolean;
  runtimeMode: RuntimeMode;
  triggerKind: AutomationTriggerKind;
  triggerEvent: string;
  scheduleKind: AutomationScheduleKind;
  minute: number;
  time: string;
  dayOfWeek: number;
  triggers?: AutomationTrigger[] | null;
  missedRunGraceMinutes: number;
  /** macOS: keep the Mac awake while a run is active. */
  keepAwake?: boolean;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt?: number;
  lastRunStatus?: AutomationRunStatus;
  lastRunError?: string;
  lastSessionId?: string;
  createdAt: number;
  updatedAt: number;
};

export type AutomationUpsert = Omit<
  Automation,
  | "lastRunAt"
  | "lastRunStatus"
  | "lastRunError"
  | "lastSessionId"
  | "createdAt"
  | "updatedAt"
>;

export type AutomationRunTrigger = "scheduled" | "manual" | "event";

export type AutomationRun = {
  id: string;
  automationId: string;
  trigger: AutomationRunTrigger;
  scheduledFor: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  status: AutomationRunStatus;
  sessionId?: string;
  error?: string;
  eventKey?: string;
  eventKind?: AutomationTriggerKind;
  event?: string;
  prompt?: string;
};

export type DueAutomationRun = {
  automation: Automation;
  run: AutomationRun;
};

export function formatAutomationRunAt(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "—";
  const date = new Date(at);
  const month = date.toLocaleDateString(undefined, { month: "short" });
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${date.getDate()} ${month}, ${time}`;
}

export function formatAutomationRunDuration(
  run: Pick<
    AutomationRun,
    "status" | "createdAt" | "startedAt" | "completedAt"
  >,
  now = Date.now(),
): string {
  const live = run.status === "pending" || run.status === "running";
  const start =
    run.startedAt ?? (run.status === "pending" ? undefined : run.createdAt);
  const end = run.completedAt ?? (live && start ? now : undefined);
  if (!start || end == null || end < start) return "—";
  const minutes = Math.floor((end - start) / 60_000);
  if (minutes < 1) return "< 1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export type AutomationDraft = {
  id?: string;
  name: string;
  prompt: string;
  harness: HarnessId;
  model: string;
  modelSettings: Record<string, string>;
  cwd: string;
  workspaceMode: AutomationWorkspaceMode;
  worktreeCwd: string;
  sessionFolderId: string;
  reuseSession: boolean;
  runtimeMode: RuntimeMode;
  triggerKind: AutomationTriggerKind;
  triggerEvent: string;
  scheduleKind: AutomationScheduleKind;
  minute: number;
  time: string;
  dayOfWeek: number;
  triggers: AutomationTrigger[];
  missedRunGraceMinutes: number;
  keepAwake: boolean;
  enabled: boolean;
};

export const AUTOMATION_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export function isScheduleKind(value: string): value is AutomationScheduleKind {
  return (
    value === "hourly" ||
    value === "daily" ||
    value === "weekdays" ||
    value === "weekly" ||
    value === "once" ||
    value === "interval"
  );
}

export function createAutomationTrigger(
  kind: AutomationTriggerKind,
  event: string,
  extras: Partial<AutomationTrigger> = {},
): AutomationTrigger {
  return {
    id: extras.id ?? crypto.randomUUID(),
    kind,
    event,
    scheduleKind:
      extras.scheduleKind ??
      (kind === "time" && isScheduleKind(event) ? event : "weekdays"),
    minute: extras.minute ?? 0,
    time: extras.time ?? "09:00",
    dayOfWeek: extras.dayOfWeek ?? 1,
    repos: extras.repos ?? [],
    repo: extras.repo ?? "",
    branch: extras.branch ?? "",
    actor: extras.actor ?? "anyone",
    ...(kind === "time" && (extras.scheduleKind ?? event) === "once"
      ? { at: extras.at ?? defaultOnceAt() }
      : extras.at != null
        ? { at: extras.at }
        : {}),
    ...(kind === "time" && (extras.scheduleKind ?? event) === "interval"
      ? { intervalMinutes: extras.intervalMinutes ?? 60 }
      : extras.intervalMinutes != null
        ? { intervalMinutes: extras.intervalMinutes }
        : {}),
  };
}

/** Tomorrow at 09:00 local: a sensible first pick for a one-time run. */
export function defaultOnceAt(now = Date.now()): number {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

export function automationTriggers(
  automation: Pick<
    Automation,
    | "id"
    | "triggers"
    | "triggerKind"
    | "triggerEvent"
    | "scheduleKind"
    | "minute"
    | "time"
    | "dayOfWeek"
  >,
): AutomationTrigger[] {
  if (automation.triggers) return automation.triggers;
  return [
    createAutomationTrigger(
      automation.triggerKind,
      automation.triggerEvent || automation.scheduleKind,
      {
        id: `${automation.id}:legacy`,
        scheduleKind: automation.scheduleKind,
        minute: automation.minute,
        time: automation.time,
        dayOfWeek: automation.dayOfWeek,
      },
    ),
  ];
}

export function applyTriggers(
  draft: AutomationDraft,
  triggers: AutomationTrigger[],
): AutomationDraft {
  const primary =
    triggers.find((trigger) => trigger.kind === "time") ?? triggers[0];
  return {
    ...draft,
    triggers,
    triggerKind: primary?.kind ?? "time",
    triggerEvent: primary?.event ?? "",
    scheduleKind: primary?.scheduleKind ?? "weekdays",
    minute: primary?.minute ?? 0,
    time: primary?.time ?? "09:00",
    dayOfWeek: primary?.dayOfWeek ?? 1,
  };
}

export function nextTriggersRunAt(
  triggers: readonly AutomationTrigger[],
  after = Date.now(),
): number {
  const times = triggers.filter((trigger) => trigger.kind === "time");
  const next = Math.min(
    Infinity,
    ...times.map((trigger) => nextAutomationRunAt(trigger, after)),
  );
  // No time trigger, or only spent one-time ones: a placeholder a year out.
  // The store disables a spent one-time automation, and refuses to claim one.
  return Number.isFinite(next) ? next : after + YEAR_MS;
}

export function overdueTriggerOccurrences(
  triggers: readonly AutomationTrigger[],
  firstRunAt: number,
  now: number,
  limit = 100,
): Array<{ scheduledFor: number; nextRunAt: number }> {
  const occurrences: Array<{ scheduledFor: number; nextRunAt: number }> = [];
  let scheduledFor = firstRunAt;
  while (scheduledFor <= now && occurrences.length < limit) {
    const nextRunAt = nextTriggersRunAt(triggers, scheduledFor);
    if (nextRunAt <= scheduledFor) break;
    occurrences.push({ scheduledFor, nextRunAt });
    scheduledFor = nextRunAt;
  }
  return occurrences;
}

export function gmtOffsetLabel(date = new Date()): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const absolute = Math.abs(minutes);
  const hours = Math.floor(absolute / 60);
  const rest = absolute % 60;
  return rest === 0
    ? `GMT${sign}${hours}`
    : `GMT${sign}${hours}:${String(rest).padStart(2, "0")}`;
}

export function nextRunPreview(at: number): string {
  const date = new Date(at);
  const day = date
    .toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
    })
    .replace(/,/g, "");
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const zone =
    new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ??
    gmtOffsetLabel(date);
  return `Next run ${day}, ${time} ${zone}`;
}

export function nextAutomationRunAt(
  schedule: Pick<
    AutomationDraft,
    "scheduleKind" | "minute" | "time" | "dayOfWeek"
  > &
    Partial<Pick<AutomationTrigger, "at" | "intervalMinutes">>,
  after = Date.now(),
): number {
  if (schedule.scheduleKind === "once") {
    const at = schedule.at ?? 0;
    // Infinity, not a date: a spent one-time run has no next occurrence.
    return Number.isFinite(at) && at > after ? at : Infinity;
  }
  if (schedule.scheduleKind === "interval") {
    const minutes = clamp(
      schedule.intervalMinutes ?? 60,
      INTERVAL_MINUTES_MIN,
      INTERVAL_MINUTES_MAX,
    );
    return Math.floor(after / 60_000) * 60_000 + minutes * 60_000;
  }
  const start = new Date(after);
  start.setSeconds(0, 0);
  const [hour, minute] = parseTime(schedule.time);
  if (schedule.scheduleKind === "hourly") {
    const candidate = new Date(start);
    candidate.setMinutes(clamp(schedule.minute, 0, 59), 0, 0);
    if (candidate.getTime() <= after)
      candidate.setHours(candidate.getHours() + 1);
    return candidate.getTime();
  }

  const candidate = new Date(start);
  candidate.setHours(hour, minute, 0, 0);
  if (schedule.scheduleKind === "daily") {
    if (candidate.getTime() <= after)
      candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }
  if (schedule.scheduleKind === "weekdays") {
    if (candidate.getTime() <= after)
      candidate.setDate(candidate.getDate() + 1);
    while (candidate.getDay() === 0 || candidate.getDay() === 6) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate.getTime();
  }

  const day = clamp(schedule.dayOfWeek, 0, 6);
  let days = (day - candidate.getDay() + 7) % 7;
  if (days === 0 && candidate.getTime() <= after) days = 7;
  candidate.setDate(candidate.getDate() + days);
  return candidate.getTime();
}

export function automationScheduleLabel(
  automation: Pick<
    Automation,
    "scheduleKind" | "minute" | "time" | "dayOfWeek"
  > &
    Partial<Pick<AutomationTrigger, "at" | "intervalMinutes">>,
): string {
  if (automation.scheduleKind === "once") {
    return automation.at
      ? `Once, ${formatAutomationRunAt(automation.at)}`
      : "Once";
  }
  if (automation.scheduleKind === "interval") {
    return `Every ${intervalLabel(automation.intervalMinutes ?? 60)}`;
  }
  const time = formatClock(automation.time);
  if (automation.scheduleKind === "hourly") {
    return `Hourly at :${String(automation.minute).padStart(2, "0")}`;
  }
  if (automation.scheduleKind === "daily") return `Daily at ${time}`;
  if (automation.scheduleKind === "weekdays") return `Weekdays at ${time}`;
  return `${AUTOMATION_WEEKDAYS[automation.dayOfWeek] ?? "Weekly"} at ${time}`;
}

export function newAutomationDraft(
  cwd: string,
  harness: HarnessId,
  model: string,
): AutomationDraft {
  return {
    name: "",
    prompt: "",
    harness,
    model,
    modelSettings: {},
    cwd,
    workspaceMode: "worktree",
    worktreeCwd: "",
    sessionFolderId: "",
    reuseSession: false,
    runtimeMode: "auto",
    triggerKind: "time",
    triggerEvent: "",
    scheduleKind: "weekdays",
    minute: 0,
    time: "09:00",
    dayOfWeek: 1,
    triggers: [],
    missedRunGraceMinutes: 720,
    keepAwake: false,
    enabled: true,
  };
}

export function draftFromTemplate(
  cwd: string,
  harness: HarnessId,
  model: string,
  template: {
    name: string;
    prompt: string;
    trigger: {
      kind: AutomationTriggerKind;
      event: string;
      scheduleKind?: AutomationScheduleKind;
      time?: string;
      dayOfWeek?: number;
      minute?: number;
    };
  },
): AutomationDraft {
  const draft = newAutomationDraft(cwd, harness, model);
  const trigger = createAutomationTrigger(
    template.trigger.kind,
    template.trigger.event,
    {
      scheduleKind: template.trigger.scheduleKind,
      time: template.trigger.time,
      dayOfWeek: template.trigger.dayOfWeek,
      minute: template.trigger.minute,
    },
  );
  return applyTriggers(
    {
      ...draft,
      name: template.name,
      prompt: template.prompt,
    },
    [trigger],
  );
}

export function draftFromAutomation(automation: Automation): AutomationDraft {
  return {
    id: automation.id,
    name: automation.name,
    prompt: automation.prompt,
    harness: automation.harness,
    model: automation.model,
    modelSettings: automation.modelSettings ?? {},
    cwd: automation.cwd,
    workspaceMode: automation.workspaceMode,
    worktreeCwd: automation.worktreeCwd ?? "",
    sessionFolderId: automation.sessionFolderId ?? "",
    reuseSession: automation.reuseSession,
    runtimeMode: automation.runtimeMode,
    triggerKind: automation.triggerKind,
    triggerEvent: automation.triggerEvent,
    scheduleKind: automation.scheduleKind,
    minute: automation.minute,
    time: automation.time,
    dayOfWeek: automation.dayOfWeek,
    triggers: automationTriggers(automation),
    missedRunGraceMinutes: automation.missedRunGraceMinutes,
    keepAwake: automation.keepAwake ?? false,
    enabled: automation.enabled,
  };
}

let cachedAutomations: Automation[] | null = null;

/** Last successful list, for an immediate first render while refreshing. */
export function peekAutomations(): Automation[] | null {
  return cachedAutomations;
}

export async function listAutomations(): Promise<Automation[]> {
  const next = await invoke<Automation[]>("automations_list");
  cachedAutomations = next;
  return next;
}

export async function saveAutomation(
  draft: AutomationDraft,
): Promise<Automation> {
  const synced = applyTriggers(draft, draft.triggers);
  const automation: AutomationUpsert = {
    ...synced,
    id: synced.id ?? crypto.randomUUID(),
    nextRunAt: nextTriggersRunAt(synced.triggers),
  };
  const saved = await invoke<Automation>("automations_upsert", { automation });
  emitLocalChange();
  return saved;
}

export async function setAutomationEnabled(
  automation: Automation,
  enabled: boolean,
): Promise<Automation> {
  return saveAutomation({ ...draftFromAutomation(automation), enabled });
}

export async function deleteAutomation(id: string): Promise<void> {
  await invoke("automations_delete", { id });
  emitLocalChange();
}

export function listAutomationRuns(
  automationId: string,
): Promise<AutomationRun[]> {
  return invoke("automation_runs_list", { automationId });
}

export function recoverAutomationRuns(
  startedBefore: number,
  now = Date.now(),
): Promise<DueAutomationRun[]> {
  return invoke("automation_runs_recover", { startedBefore, now });
}

export async function createManualAutomationRun(
  automationId: string,
): Promise<AutomationRun> {
  const run = await invoke<AutomationRun>("automation_run_now", {
    automationId,
    now: Date.now(),
  });
  emitLocalChange();
  return run;
}

/**
 * Run a saved automation now, as the Run now button does, for an agent's
 * `automations.run` (#39). `launch` is the app's own launcher.
 */
export async function startManualAutomationRun(
  automationId: string,
  launch: (automation: Automation, run: AutomationRun) => Promise<void>,
): Promise<void> {
  const automation = (await listAutomations()).find(
    (item) => item.id === automationId,
  );
  if (!automation) throw new Error("Automation not found.");
  const run = await createManualAutomationRun(automationId);
  await launch(automation, run);
}

export async function claimDueAutomations(
  now = Date.now(),
): Promise<DueAutomationRun[]> {
  const automations = await listAutomations();
  const due = automations.filter(
    (automation) =>
      automation.enabled &&
      automationTriggers(automation).some(
        (trigger) => trigger.kind === "time",
      ) &&
      automation.nextRunAt <= now,
  );
  const claimed: DueAutomationRun[] = [];
  for (const automation of due) {
    const triggers = automationTriggers(automation);
    // Bound each polling pass so a long offline period cannot monopolize the
    // webview. Any remaining overdue occurrences stay due for the next pass.
    for (const occurrence of overdueTriggerOccurrences(
      triggers,
      automation.nextRunAt,
      now,
    )) {
      let result: DueAutomationRun | null;
      try {
        result = await invoke<DueAutomationRun | null>(
          "automations_claim_due",
          {
            automationId: automation.id,
            expectedNextRunAt: occurrence.scheduledFor,
            nextRunAt: occurrence.nextRunAt,
            now,
          },
        );
      } catch {
        // Keep earlier successful claims launchable. This occurrence remains
        // due because the backend transaction did not accept it.
        break;
      }
      if (!result) break;
      if (result.run.status === "pending") claimed.push(result);
    }
  }
  if (due.length > 0) emitLocalChange();
  return claimed;
}

/**
 * The run status and error for how a run's turn settled. A run is Succeeded
 * only when its turn completed; anything else, a setup step that threw
 * before the agent started included (a worktree that could not be made, Mac
 * test 2.16), is Failed with its error, or Cancelled.
 */
export function automationRunSettlement(outcome: {
  status: "completed" | "failed" | "cancelled";
  error?: string;
}): { status: AutomationRunStatus; error?: string } {
  if (outcome.status === "completed" && !outcome.error?.trim())
    return { status: "succeeded" };
  if (outcome.status === "cancelled")
    return {
      status: "cancelled",
      ...(outcome.error?.trim() ? { error: outcome.error.trim() } : {}),
    };
  return {
    status: "failed",
    error: outcome.error?.trim() || "The run failed before the agent answered.",
  };
}

export async function updateAutomationRun(
  runId: string,
  status: AutomationRunStatus,
  options: { sessionId?: string; error?: string } = {},
): Promise<AutomationRun> {
  const run = await invoke<AutomationRun>("automation_run_update", {
    runId,
    status,
    sessionId: options.sessionId ?? null,
    error: options.error ?? null,
    now: Date.now(),
  });
  emitLocalChange();
  return run;
}

export function notifyAutomationsChanged() {
  emitLocalChange();
}

export function subscribeAutomations(onChange: () => void): () => void {
  const onLocal = () => onChange();
  window.addEventListener(LOCAL_CHANGED, onLocal);
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void listen(AUTOMATIONS_CHANGED, () => {
    cachedAutomations = null;
    onChange();
  })
    .then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch(() => undefined);
  return () => {
    disposed = true;
    unlisten?.();
    window.removeEventListener(LOCAL_CHANGED, onLocal);
  };
}

function emitLocalChange() {
  cachedAutomations = null;
  window.dispatchEvent(new Event(LOCAL_CHANGED));
}

export function intervalLabel(minutes: number): string {
  const value = clamp(minutes, INTERVAL_MINUTES_MIN, INTERVAL_MINUTES_MAX);
  if (value % 1440 === 0) {
    const days = value / 1440;
    return days === 1 ? "day" : `${days} days`;
  }
  if (value % 60 === 0) {
    const hours = value / 60;
    return hours === 1 ? "hour" : `${hours} hours`;
  }
  return `${value} minutes`;
}

/** A local date and clock for a moment, for the one-time schedule's fields. */
export function splitLocalMoment(at: number): { date: string; time: string } {
  const date = new Date(Number.isFinite(at) && at > 0 ? at : defaultOnceAt());
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

/** The moment for a local date and clock, or null when either is not valid. */
export function joinLocalMoment(date: string, time: string): number | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const clock = /^(\d{2}):(\d{2})$/.exec(time);
  if (!day || !clock) return null;
  const [year, month, dom] = [Number(day[1]), Number(day[2]), Number(day[3])];
  const [hour, minute] = [Number(clock[1]), Number(clock[2])];
  if (hour > 23 || minute > 59 || month < 1 || month > 12 || dom < 1)
    return null;
  const moment = new Date(year, month - 1, dom, hour, minute, 0, 0);
  // Rejects 31 February and the like, which Date would roll over.
  if (moment.getMonth() !== month - 1 || moment.getDate() !== dom) return null;
  return moment.getTime();
}

function parseTime(value: string): [number, number] {
  const [hour, minute] = value.split(":").map(Number);
  return [clamp(hour, 0, 23), clamp(minute, 0, 59)];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function formatClock(value: string): string {
  const [hour, minute] = parseTime(value);
  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
