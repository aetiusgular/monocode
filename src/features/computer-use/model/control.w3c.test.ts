import { describe, expect, it } from "vitest";
import { controlView } from "./control";

const base = { on: false, grants: 0, running: false, helper: "stopped" as const };

describe("the composer control", () => {
  it("is hidden where computer use can never run (corner case 11)", () => {
    for (const block of ["platform", "harness", "app"] as const) {
      expect(controlView({ ...base, block }).visible).toBe(false);
    }
  });

  it("offers the vision override for a model that does not read images (corner case 4)", () => {
    const view = controlView({ ...base, block: "vision" });
    expect(view.visible).toBe(true);
    expect(view.tone).toBe("blocked");
    expect(view.note).toMatch(/Use without vision/);
  });

  it("counts the apps and shows the stop control while any is granted or running", () => {
    expect(controlView({ ...base, on: true }).showStop).toBe(false);
    const one = controlView({ ...base, on: true, grants: 1 });
    expect(one.label).toBe("Computer use · 1 app");
    expect(one.showStop).toBe(true);
    const running = controlView({ ...base, on: true, grants: 2, running: true });
    expect(running.tone).toBe("running");
    expect(running.title).toMatch(/running with 2 apps/);
  });

  it("says when the helper is not installed", () => {
    expect(controlView({ ...base, on: true, helper: "missing" }).note).toMatch(/not installed/);
  });

  it("keeps stop reachable after the switch goes off with a runtime still running", () => {
    expect(controlView({ ...base, on: false, running: true }).showStop).toBe(true);
  });
});
