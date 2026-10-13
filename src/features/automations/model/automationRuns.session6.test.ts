import { beforeEach, describe, expect, it, vi } from "vitest";

// Mac test 2.16: an agent-made automation uses a fresh worktree; in a
// repository with no commits its run ended at once and still read Done.

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

import { submitWithSettlement } from "../../../app/model/managedSubmission";
import {
  acceptAutomationProposal,
  loadAutomationProposals,
  proposeAutomation,
} from "./automationProposals";
import {
  automationRunSettlement,
  createAutomationTrigger,
  newAutomationDraft,
  type Automation,
} from "./automations";

const PROJECT = "/Users/tony/s7-pickup";
const NO_COMMITS =
  "This repository has no commits yet, so a fresh worktree cannot be made from it. Make a first commit, or set Working copy to Current.";

beforeEach(() => files.clear());

describe("automationRunSettlement", () => {
  it("is Succeeded only for a turn that completed", () => {
    expect(automationRunSettlement({ status: "completed" })).toEqual({
      status: "succeeded",
    });
  });

  it("marks a setup failure Failed with git's error", () => {
    expect(
      automationRunSettlement({
        status: "failed",
        error: "fatal: Needed a single revision",
      }),
    ).toEqual({ status: "failed", error: "fatal: Needed a single revision" });
  });

  it("never reads a completed outcome that carries an error as a success", () => {
    expect(
      automationRunSettlement({ status: "completed", error: "fatal: Needed a single revision" }),
    ).toEqual({ status: "failed", error: "fatal: Needed a single revision" });
  });

  it("gives a failure with no text a reason", () => {
    expect(automationRunSettlement({ status: "failed", error: "  " })).toEqual({
      status: "failed",
      error: "The run failed before the agent answered.",
    });
  });

  it("keeps a stopped run Cancelled", () => {
    expect(automationRunSettlement({ status: "cancelled" })).toEqual({
      status: "cancelled",
    });
  });
});

describe("a run whose setup throws", () => {
  it("settles as Failed with the error, through the launcher's path", async () => {
    // launchAutomation hands submitSession to submitWithSettlement; the
    // worktree step throws inside it before any agent turn starts.
    const settled: Array<ReturnType<typeof automationRunSettlement>> = [];
    await submitWithSettlement({
      submit: (onSettled) => {
        onSettled({
          status: "failed",
          text: "",
          error: "fatal: Needed a single revision",
        });
        return true;
      },
      rejectionMessage: "not started",
      onSettled: (outcome) => settled.push(automationRunSettlement(outcome)),
    });
    expect(settled).toEqual([
      { status: "failed", error: "fatal: Needed a single revision" },
    ]);
  });
});

describe("accepting a worktree automation in a repository with no commits", () => {
  it("keeps the card and passes on the reason the save was refused", async () => {
    const proposal = await proposeAutomation(
      {
        kind: "create",
        project: PROJECT,
        name: "Weekday tests",
        prompt: "Run the tests",
        schedule: "weekdays 09:00",
        trigger: createAutomationTrigger("time", "weekdays", { time: "09:00" }),
        workspaceMode: "worktree",
        harness: "claude",
        model: "haiku",
      },
      Date.now(),
    );
    const save = vi.fn(async (): Promise<Automation> => {
      // automations_upsert refuses it (refuse_unborn_worktree in Rust).
      throw new Error(NO_COMMITS);
    });
    await expect(
      acceptAutomationProposal(PROJECT, proposal.id, {
        list: async () => [],
        save,
        remove: async () => {},
      }),
    ).rejects.toThrow("no commits yet");
    expect(save.mock.calls[0]?.[0]).toMatchObject({ workspaceMode: "worktree" });
    expect((await loadAutomationProposals(PROJECT)).map((p) => p.id)).toEqual([
      proposal.id,
    ]);
  });

  it("an agent proposal with no workspace takes the worktree default", () => {
    expect(newAutomationDraft(PROJECT, "claude", "m").workspaceMode).toBe("worktree");
  });
});
