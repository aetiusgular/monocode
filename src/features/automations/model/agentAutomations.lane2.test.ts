import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// An in-memory project context store, in place of the Rust command.
const files = vi.hoisted(() => new Map<string, string>());
vi.mock("../../project-context/model/projectContext", () => ({
  readProjectContext: async (project: string, file: string) => ({
    text: files.get(`${project}|${file}`) ?? null,
    hash: "h",
  }),
  editProjectContext: async (
    project: string,
    file: string,
    edit: (text: string) => { text: string; result: unknown },
  ) => {
    const next = edit(files.get(`${project}|${file}`) ?? "");
    files.set(`${project}|${file}`, next.text);
    return next.result;
  },
  subscribeProjectContext: () => () => {},
}));

import {
  handleAutomationAction,
  parseScheduleText,
  type AutomationActionDeps,
} from "./agentAutomations";
import {
  AUTOMATION_PROPOSALS_MAX,
  acceptAutomationProposal,
  loadAutomationProposals,
  parseAutomationProposals,
  proposalDraft,
  proposeAutomation,
} from "./automationProposals";
import {
  createAutomationTrigger,
  newAutomationDraft,
  type Automation,
} from "./automations";
import { ProposalCard } from "../ui/AutomationProposals";
import type { Session } from "../../sessions/model/session";

const NOW = new Date("2026-10-12T10:00:00").getTime();
const PROJECT = "/Users/tony/code/app";

const source = {
  id: "s1",
  cwd: PROJECT,
  harness: "codex",
  model: "qwen2.5:7b",
  runtimeMode: "supervised",
} as unknown as Session;

function saved(over: Partial<Automation> = {}): Automation {
  return {
    ...newAutomationDraft(PROJECT, "claude", "sonnet"),
    id: "auto-1",
    name: "Nightly tests",
    prompt: "Run the tests",
    triggers: [createAutomationTrigger("time", "daily", { time: "02:00" })],
    nextRunAt: NOW + 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function deps(list: Automation[] = [saved()]): AutomationActionDeps {
  return {
    list: async () => list,
    propose: proposeAutomation,
    waiting: loadAutomationProposals,
  };
}

const host = { now: () => new Date(NOW) };

beforeEach(() => files.clear());

describe("parseScheduleText", () => {
  it("reads every documented form", () => {
    const daily = parseScheduleText("daily 9:30", NOW);
    expect(typeof daily !== "string" && daily.scheduleKind).toBe("daily");
    expect(typeof daily !== "string" && daily.time).toBe("09:30");
    const hourly = parseScheduleText("hourly :15", NOW);
    expect(typeof hourly !== "string" && hourly.minute).toBe(15);
    const weekly = parseScheduleText("weekly Monday at 08:00", NOW);
    expect(typeof weekly !== "string" && weekly.dayOfWeek).toBe(1);
    const once = parseScheduleText("once 2026-10-14 09:00", NOW);
    expect(typeof once !== "string" && once.at).toBe(
      new Date("2026-10-14T09:00:00").getTime(),
    );
    const every = parseScheduleText("every 2h", NOW);
    expect(typeof every !== "string" && every.intervalMinutes).toBe(120);
    const minutes = parseScheduleText("every 30 minutes", NOW);
    expect(typeof minutes !== "string" && minutes.intervalMinutes).toBe(30);
  });

  it("answers what a small model gets wrong with the forms it may use", () => {
    for (const bad of [
      "",
      "tomorrow morning",
      "daily",
      "daily 25:00",
      "weekly 09:00",
      "weekly mo 09:00",
      "hourly :75",
      "once 2026-02-31 09:00",
      "every fortnight",
      "0 9 * * 1-5",
    ]) {
      const result = parseScheduleText(bad, NOW);
      expect(typeof result, bad).toBe("string");
    }
    expect(parseScheduleText("every 1m", NOW)).toMatch(/5 minutes and 30 days/);
    expect(parseScheduleText("once 2026-10-11 09:00", NOW)).toMatch(
      /already passed/,
    );
    expect(String(parseScheduleText("whenever", NOW))).toContain(
      "weekdays 09:00",
    );
  });
});

describe("automations.* app actions", () => {
  it("lists only this project's automations", async () => {
    const other = saved({ id: "auto-2", cwd: "/Users/tony/code/other" });
    const result = (await handleAutomationAction(
      source,
      "automations.list",
      {},
      host,
      deps([saved(), other]),
    )) as { automations: { id: string; schedule: string }[] };
    expect(result.automations.map((a) => a.id)).toEqual(["auto-1"]);
    expect(result.automations[0]!.schedule).toMatch(/^Daily at/);
  });

  it("turns create into a proposal and saves nothing", async () => {
    const list = [saved()];
    const result = (await handleAutomationAction(
      source,
      "automations.create",
      { name: "Morning", prompt: "Check CI", schedule: "weekdays 08:30" },
      host,
      deps(list),
    )) as { waiting: boolean; note: string };
    expect(result.waiting).toBe(true);
    expect(result.note).toMatch(/Automations page/);
    expect(list).toHaveLength(1);
    const [proposal] = await loadAutomationProposals(PROJECT);
    expect(proposal).toMatchObject({
      kind: "create",
      name: "Morning",
      harness: "codex",
      model: "qwen2.5:7b",
      // The asking session's own mode, unless the agent named one.
      runtimeMode: "supervised",
    });
  });

  it("refuses bad input with a reason, never a half proposal", async () => {
    const run = (action: string, input: Record<string, unknown>) =>
      handleAutomationAction(source, action, input, host, deps());
    await expect(
      run("automations.create", { name: "x", prompt: "y" }),
    ).rejects.toThrow(/schedule is required/);
    await expect(
      run("automations.create", {
        name: "x",
        prompt: "y",
        schedule: "daily 9",
      }),
    ).rejects.toThrow(/Could not read/);
    await expect(
      run("automations.create", {
        name: "x",
        prompt: "y",
        schedule: "daily 09:00",
        runtimeMode: "root",
      }),
    ).rejects.toThrow(/runtimeMode/);
    await expect(
      run("automations.create", {
        name: "x",
        prompt: "y".repeat(20_001),
        schedule: "daily 09:00",
      }),
    ).rejects.toThrow(/too long/);
    await expect(run("automations.update", { id: "auto-1" })).rejects.toThrow(
      /Nothing to change/,
    );
    await expect(
      run("automations.update", { id: "elsewhere", enabled: false }),
    ).rejects.toThrow(/No automation/);
    expect(await loadAutomationProposals(PROJECT)).toEqual([]);
  });

  it("keeps update and remove waiting for the user", async () => {
    await handleAutomationAction(
      source,
      "automations.update",
      { id: "auto-1", schedule: "every 30m" },
      host,
      deps(),
    );
    await handleAutomationAction(
      source,
      "automations.remove",
      { id: "auto-1" },
      host,
      deps(),
    );
    const waiting = await loadAutomationProposals(PROJECT);
    expect(waiting.map((p) => p.kind)).toEqual(["update", "remove"]);
    expect(waiting[1]!.currentName).toBe("Nightly tests");
  });

  it("caps proposals instead of dropping old ones silently", async () => {
    for (let i = 0; i < AUTOMATION_PROPOSALS_MAX; i++)
      await handleAutomationAction(
        source,
        "automations.remove",
        { id: "auto-1" },
        host,
        deps(),
      );
    await expect(
      handleAutomationAction(
        source,
        "automations.remove",
        { id: "auto-1" },
        host,
        deps(),
      ),
    ).rejects.toThrow(/already waiting/);
  });

  it("runs a saved automation once, and not while it is running", async () => {
    const runAutomation = vi.fn(async () => {});
    await handleAutomationAction(
      source,
      "automations.run",
      { id: "auto-1" },
      { ...host, runAutomation },
      deps([saved({ runtimeMode: "supervised" })]),
    );
    expect(runAutomation).toHaveBeenCalledWith("auto-1");
    await expect(
      handleAutomationAction(
        source,
        "automations.run",
        { id: "auto-1" },
        { ...host, runAutomation },
        deps([
          saved({ runtimeMode: "supervised", lastRunStatus: "running" }),
        ]),
      ),
    ).rejects.toThrow(/already running/);
  });

  it("never lets an agent start a run wider than its own chat", async () => {
    const runAutomation = vi.fn(async () => {});
    for (const runtimeMode of ["auto", "full-access"] as const) {
      await expect(
        handleAutomationAction(
          { ...source, runtimeMode: "full-access" } as Session,
          "automations.run",
          { id: "auto-1" },
          { ...host, runAutomation },
          deps([saved({ runtimeMode })]),
        ),
      ).rejects.toThrow(/Run now on the Automations page/);
    }
    await expect(
      handleAutomationAction(
        source,
        "automations.run",
        { id: "auto-1" },
        { ...host, runAutomation },
        deps([saved({ runtimeMode: "auto-accept-edits" })]),
      ),
    ).rejects.toThrow(/cannot start from a supervised chat/);
    expect(runAutomation).not.toHaveBeenCalled();
    await handleAutomationAction(
      { ...source, runtimeMode: "auto-accept-edits" } as Session,
      "automations.run",
      { id: "auto-1" },
      { ...host, runAutomation },
      deps([saved({ runtimeMode: "auto-accept-edits" })]),
    );
    expect(runAutomation).toHaveBeenCalledTimes(1);
  });

  it("refuses a habit run and a thread with no project", async () => {
    await expect(
      handleAutomationAction(
        source,
        "automations.list",
        {},
        { ...host, isHabitRun: () => true },
        deps(),
      ),
    ).rejects.toThrow(/habit run/);
    await expect(
      handleAutomationAction(
        { ...source, cwd: "~" } as Session,
        "automations.list",
        {},
        host,
        deps(),
      ),
    ).rejects.toThrow(/project/);
  });
});

describe("accepting a proposal", () => {
  it("builds the draft the card shows", async () => {
    const created = await proposeAutomation(
      {
        kind: "create",
        project: PROJECT,
        name: "Once",
        prompt: "Tag the release",
        schedule: "once 2026-10-14 09:00",
        trigger: createAutomationTrigger("time", "once", {
          at: new Date("2026-10-14T09:00:00").getTime(),
        }),
        harness: "claude",
        model: "sonnet",
      },
      NOW,
    );
    const draft = proposalDraft(created, undefined)!;
    expect(draft.cwd).toBe(PROJECT);
    expect(draft.triggers).toHaveLength(1);
    expect(draft.scheduleKind).toBe("once");
  });

  it("keeps a change's event triggers and replaces its time trigger", () => {
    const existing = saved({
      triggers: [
        createAutomationTrigger("time", "daily"),
        createAutomationTrigger("github", "pull_request_opened"),
      ],
    });
    const draft = proposalDraft(
      {
        id: "p",
        kind: "update",
        project: PROJECT,
        automationId: "auto-1",
        trigger: createAutomationTrigger("time", "interval", {
          intervalMinutes: 30,
        }),
        at: 1,
      },
      existing,
    )!;
    expect(draft.triggers.map((t) => t.scheduleKind)).toContain("interval");
    expect(draft.triggers.map((t) => t.kind).sort()).toEqual([
      "github",
      "time",
    ]);
    expect(draft.name).toBe("Nightly tests");
  });

  it("saves on accept and removes on a confirmed remove", async () => {
    const save = vi.fn(async (draft) => ({ ...saved(), name: draft.name }));
    const remove = vi.fn(async () => {});
    const store = { list: async () => [saved()], save, remove };
    const update = await proposeAutomation(
      {
        kind: "update",
        project: PROJECT,
        automationId: "auto-1",
        name: "Renamed",
      },
      NOW,
    );
    const result = await acceptAutomationProposal(PROJECT, update.id, store);
    expect(result?.name).toBe("Renamed");
    const gone = await proposeAutomation(
      { kind: "remove", project: PROJECT, automationId: "auto-1" },
      NOW,
    );
    expect(await acceptAutomationProposal(PROJECT, gone.id, store)).toBeNull();
    expect(remove).toHaveBeenCalledWith("auto-1");
    expect(await loadAutomationProposals(PROJECT)).toEqual([]);
  });

  it("keeps the card when the save is refused", async () => {
    const store = {
      list: async () => [saved()],
      save: async () => {
        throw new Error("Pick a time in the future for the one-time run.");
      },
      remove: async () => {},
    };
    const update = await proposeAutomation(
      { kind: "update", project: PROJECT, automationId: "auto-1", name: "x" },
      NOW,
    );
    await expect(
      acceptAutomationProposal(PROJECT, update.id, store),
    ).rejects.toThrow(/future/);
    expect(await loadAutomationProposals(PROJECT)).toHaveLength(1);
  });

  it("drops malformed stored proposals", () => {
    expect(parseAutomationProposals("not json")).toEqual([]);
    expect(
      parseAutomationProposals(
        JSON.stringify([
          { id: "a", kind: "create", project: PROJECT },
          { id: "b", kind: "update", project: PROJECT },
          { id: "c", kind: "launch", project: PROJECT, automationId: "x" },
          { id: "d", kind: "remove", project: PROJECT, automationId: "x" },
        ]),
      ).map((p) => p.id),
    ).toEqual(["d"]);
  });
});

describe("the proposal card", () => {
  it("shows the whole prompt as text and warns about unattended modes", () => {
    const html = renderToStaticMarkup(
      createElement(ProposalCard, {
        item: {
          id: "p",
          kind: "create",
          project: PROJECT,
          name: "Sweep",
          prompt: "<img src=x onerror=alert(1)> delete the branch",
          trigger: createAutomationTrigger("time", "interval", {
            intervalMinutes: 60,
          }),
          runtimeMode: "full-access",
          harness: "claude",
          model: "sonnet",
          at: 1,
        },
        existing: undefined,
        busy: false,
        onAccept: () => {},
        onEdit: () => {},
        onDismiss: () => {},
      }),
    );
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
    expect(html).toContain("Every hour");
    expect(html).toContain("Read the prompt before you accept");
    expect(html).toContain("Accept");
  });

  it("offers no accept for a change to an automation that is gone", () => {
    const html = renderToStaticMarkup(
      createElement(ProposalCard, {
        item: {
          id: "p",
          kind: "remove",
          project: PROJECT,
          automationId: "gone",
          currentName: "Old",
          at: 1,
        },
        existing: undefined,
        busy: false,
        onAccept: () => {},
        onDismiss: () => {},
      }),
    );
    expect(html).toContain("no longer exists");
    expect(html).not.toContain("Remove it");
  });
});
