// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collapsedProjectTabGroups,
  resetCollapsedProjectTabGroups,
  setProjectTabGroupCollapsed,
  subscribeCollapsedProjectTabGroups,
  toggleProjectTabGroup,
} from "./collapsedProjectTabs";

const KEY = "monocode:tab-groups:collapsed";

beforeEach(() => {
  localStorage.clear();
  resetCollapsedProjectTabGroups();
});

afterEach(() => {
  localStorage.clear();
  resetCollapsedProjectTabGroups();
});

describe("collapsed project tab groups", () => {
  it("starts from what was saved", () => {
    localStorage.setItem(KEY, JSON.stringify(["/repos/alpha"]));
    expect([...collapsedProjectTabGroups()]).toEqual(["/repos/alpha"]);
  });

  it("saves every flip and tells subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCollapsedProjectTabGroups(listener);

    toggleProjectTabGroup("/repos/alpha");
    expect(collapsedProjectTabGroups().has("/repos/alpha")).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["/repos/alpha"]);
    expect(listener).toHaveBeenCalledTimes(1);

    toggleProjectTabGroup("/repos/alpha");
    expect(collapsedProjectTabGroups().has("/repos/alpha")).toBe(false);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    toggleProjectTabGroup("/repos/beta");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps the same set while nothing changes", () => {
    const before = collapsedProjectTabGroups();
    setProjectTabGroupCollapsed("/repos/alpha", false);
    expect(collapsedProjectTabGroups()).toBe(before);
    setProjectTabGroupCollapsed("/repos/alpha", true);
    expect(collapsedProjectTabGroups()).not.toBe(before);
  });
});
