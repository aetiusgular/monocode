import { describe, expect, it } from "vitest";
import type {
  Block,
  TaskListItem,
  TaskListItemStatus,
} from "../../sessions/model/session";
import {
  earlierStepsLabel,
  earlierStepsToggleLabel,
  foldEarlierSteps,
  latestTaskList,
  latestTaskListBlock,
  runningStepKey,
} from "./sessionProgress";

function items(...statuses: TaskListItemStatus[]): TaskListItem[] {
  return statuses.map((status, index) => ({
    id: String(index + 1),
    text: `Step ${index + 1}`,
    status,
  }));
}

function tasks(id: string, list: TaskListItem[]): Block {
  return { id, role: "tasks", text: "", taskList: { key: id, items: list } };
}

describe("latestTaskList", () => {
  it("returns null when the session has no task list", () => {
    expect(latestTaskList([])).toBeNull();
    expect(
      latestTaskList([
        { id: "u", role: "user", text: "Fix the build" },
        { id: "a", role: "assistant", text: "Done." },
      ]),
    ).toBeNull();
  });

  it("picks the last task list in the transcript", () => {
    const first = items("completed", "completed");
    const second = items("completed", "in_progress", "pending");
    const found = latestTaskList([
      { id: "u1", role: "user", text: "First" },
      tasks("one", first),
      { id: "u2", role: "user", text: "Second" },
      tasks("two", second),
      { id: "a", role: "assistant", text: "Working on it." },
    ]);
    expect(found?.key).toBe("two");
    expect(found?.items).toEqual(second);
  });

  it("skips a list that was emptied", () => {
    const kept = items("pending");
    expect(latestTaskList([tasks("one", kept), tasks("two", [])])?.key).toBe(
      "one",
    );
  });

  it("reads a task snapshot saved as a plan block", () => {
    const found = latestTaskList([
      { id: "p", role: "plan", text: "[x] Inspect\n[~] Implement\n[ ] Verify" },
    ]);
    expect(found?.items.map((item) => item.status)).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
  });

  it("does not read a prose plan as a task list", () => {
    expect(
      latestTaskList([
        { id: "p", role: "plan", text: "# Plan\n\nRewrite the parser." },
      ]),
    ).toBeNull();
  });
});

describe("foldEarlierSteps", () => {
  it("folds nothing when no step is completed", () => {
    const list = items("in_progress", "pending", "pending");
    expect(foldEarlierSteps(list)).toEqual({ earlier: [], rest: list });
  });

  it("folds the completed steps before the first unfinished one", () => {
    const list = items("completed", "completed", "in_progress", "pending");
    const fold = foldEarlierSteps(list);
    expect(fold.earlier.map((item) => item.id)).toEqual(["1", "2"]);
    expect(fold.rest.map((item) => item.id)).toEqual(["3", "4"]);
  });

  it("shows a finished list whole", () => {
    const list = items("completed", "completed", "completed");
    expect(foldEarlierSteps(list)).toEqual({ earlier: [], rest: list });
  });

  it("leaves a step completed after a pending one where it is", () => {
    const list = items("completed", "pending", "completed", "pending");
    const fold = foldEarlierSteps(list);
    expect(fold.earlier.map((item) => item.id)).toEqual(["1"]);
    expect(fold.rest.map((item) => item.id)).toEqual(["2", "3", "4"]);
  });

  it("folds nothing when the list opens on an unfinished step", () => {
    const list = items("pending", "completed", "completed");
    expect(foldEarlierSteps(list)).toEqual({ earlier: [], rest: list });
  });

  it("stops at a cancelled step", () => {
    const list = items("completed", "cancelled", "completed", "pending");
    expect(foldEarlierSteps(list).earlier.map((item) => item.id)).toEqual([
      "1",
    ]);
  });

  it("handles an empty list", () => {
    expect(foldEarlierSteps([])).toEqual({ earlier: [], rest: [] });
  });
});

describe("earlierStepsLabel", () => {
  it("counts steps in the singular and the plural", () => {
    expect(earlierStepsLabel(1)).toBe("1 earlier step");
    expect(earlierStepsLabel(5)).toBe("5 earlier steps");
  });
});

describe("latestTaskListBlock", () => {
  it("says which block shows the list", () => {
    const blocks = [
      tasks("first", items("completed")),
      { id: "a", role: "assistant", text: "Next." } as Block,
      tasks("second", items("pending")),
    ];
    expect(latestTaskListBlock(blocks)?.blockId).toBe("second");
    expect(latestTaskListBlock([])).toBeNull();
  });
});

describe("earlierStepsToggleLabel", () => {
  it("counts the steps while shut and offers to hide them while open", () => {
    expect(earlierStepsToggleLabel(23, false)).toBe("23 earlier steps");
    expect(earlierStepsToggleLabel(23, true)).toBe("Hide earlier steps");
    expect(earlierStepsToggleLabel(1, false)).toBe("1 earlier step");
    expect(earlierStepsToggleLabel(1, true)).toBe("Hide earlier step");
  });
});

describe("runningStepKey", () => {
  it("is the running step's id, and changes when the agent moves on", () => {
    expect(runningStepKey(items("completed", "in_progress", "pending"))).toBe(
      "2",
    );
    expect(runningStepKey(items("completed", "completed", "in_progress"))).toBe(
      "3",
    );
  });

  it("is null when nothing is running", () => {
    expect(runningStepKey(items("completed", "pending"))).toBeNull();
    expect(runningStepKey([])).toBeNull();
  });

  it("falls back to position and text for a step without an id", () => {
    expect(
      runningStepKey([
        { text: "Build", status: "in_progress" } as TaskListItem,
      ]),
    ).toBe("0:Build");
  });
});
