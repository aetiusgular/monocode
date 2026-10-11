import { describe, expect, it } from "vitest";

import {
  WORKSPACE_SAVE_MAX_WAIT_MS,
  WORKSPACE_SAVE_QUIET_MS,
  planWorkspaceSave,
  type PendingWorkspaceSave,
} from "./workspaceSave";

describe("planWorkspaceSave", () => {
  it("waits for a quiet window after a new key", () => {
    expect(
      planWorkspaceSave({ key: "b", savedKey: "a", pending: null, now: 1000 }),
    ).toEqual({
      action: "wait",
      ms: WORKSPACE_SAVE_QUIET_MS,
      pending: { key: "b", since: 1000 },
    });
  });

  it("skips a key that is already saved and drops anything pending", () => {
    expect(
      planWorkspaceSave({
        key: "a",
        savedKey: "a",
        pending: { key: "b", since: 1000 },
        now: 1100,
      }),
    ).toEqual({ action: "skip", pending: null });
  });

  it("keeps the first sighting of a key that is interrupted again", () => {
    expect(
      planWorkspaceSave({
        key: "b",
        savedKey: "a",
        pending: { key: "b", since: 1000 },
        now: 1200,
      }),
    ).toEqual({
      action: "wait",
      ms: WORKSPACE_SAVE_QUIET_MS,
      pending: { key: "b", since: 1000 },
    });
  });

  it("starts over when the pending key changes", () => {
    expect(
      planWorkspaceSave({
        key: "c",
        savedKey: "a",
        pending: { key: "b", since: 1000 },
        now: 1200,
      }),
    ).toEqual({
      action: "wait",
      ms: WORKSPACE_SAVE_QUIET_MS,
      pending: { key: "c", since: 1200 },
    });
  });

  it("saves at once when a key has waited the maximum", () => {
    expect(
      planWorkspaceSave({
        key: "b",
        savedKey: "a",
        pending: { key: "b", since: 1000 },
        now: 1000 + WORKSPACE_SAVE_MAX_WAIT_MS,
      }),
    ).toEqual({ action: "save", pending: null });
  });
});

/**
 * The effect as App.tsx runs it: each run cancels the previous timer, and a
 * run that plans a wait arms a new one. `saved` lists the keys written.
 */
function effectHarness() {
  let savedKey: string | null = null;
  let pending: PendingWorkspaceSave | null = null;
  let timer: { at: number; fire: () => void } | null = null;
  const saved: string[] = [];
  const run = (key: string, now: number) => {
    timer = null;
    const plan = planWorkspaceSave({ key, savedKey, pending, now });
    pending = plan.pending;
    if (plan.action === "skip") return;
    const save = () => {
      savedKey = key;
      pending = null;
      saved.push(key);
    };
    if (plan.action === "save") {
      save();
      return;
    }
    timer = { at: now + plan.ms, fire: save };
  };
  const tick = (now: number) => {
    if (timer && timer.at <= now) {
      const { fire } = timer;
      timer = null;
      fire();
    }
  };
  return { run, tick, saved };
}

describe("the save effect", () => {
  it("still saves when a session updates inside the quiet window", () => {
    const { run, tick, saved } = effectHarness();
    run("layout-1", 0);
    tick(250);
    expect(saved).toEqual(["layout-1"]);

    // A tab switch, then a session update 100 ms later with the same layout.
    run("layout-2", 1000);
    run("layout-2", 1100);
    tick(1250);
    expect(saved).toEqual(["layout-1"]);
    tick(1350);
    expect(saved).toEqual(["layout-1", "layout-2"]);

    // Nothing else to write once it is saved.
    run("layout-2", 1400);
    tick(2000);
    expect(saved).toEqual(["layout-1", "layout-2"]);
  });

  it("does not let a stream of session updates starve the save", () => {
    const { run, tick, saved } = effectHarness();
    run("layout-1", 0);
    let now = 0;
    while (now < WORKSPACE_SAVE_MAX_WAIT_MS) {
      now += 100;
      run("layout-1", now);
      tick(now);
    }
    expect(saved).toEqual(["layout-1"]);
    expect(now).toBe(WORKSPACE_SAVE_MAX_WAIT_MS);
  });

  it("writes only the newest layout when changes come in a burst", () => {
    const { run, tick, saved } = effectHarness();
    run("layout-1", 0);
    run("layout-2", 100);
    run("layout-3", 200);
    tick(450);
    expect(saved).toEqual(["layout-3"]);
  });
});
