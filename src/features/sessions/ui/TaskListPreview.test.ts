// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskListItem, TaskListItemStatus } from "../model/session";
import { resetOpenedTaskLists, TaskListPreview } from "./TaskListPreview";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetOpenedTaskLists();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function items(...statuses: TaskListItemStatus[]): TaskListItem[] {
  return statuses.map((status, index) => ({
    id: String(index + 1),
    text: `Step ${index + 1}`,
    status,
  }));
}

function render(props: Parameters<typeof TaskListPreview>[0]) {
  act(() => root.render(createElement(TaskListPreview, props)));
}

function card() {
  return container.querySelector<HTMLElement>(
    'section[aria-label="Task progress"]',
  )!;
}

function fold() {
  return card().querySelector<HTMLButtonElement>("button")!;
}

describe("TaskListPreview", () => {
  it("starts as one line naming the step in hand and the progress", () => {
    render({ items: items("completed", "in_progress", "pending") });
    expect(card().getAttribute("data-task-list")).toBe("folded");
    expect(fold().getAttribute("aria-expanded")).toBe("false");
    expect(card().querySelector("ol")).toBeNull();
    expect(card().querySelector("[data-task-list-current]")?.textContent).toBe(
      "Step 2",
    );
    expect(
      card().querySelector(
        '[data-task-list-current] [aria-label="In progress"]',
      ),
    ).not.toBeNull();
    expect(card().textContent).toContain("1 of 3");
    expect(card().textContent).not.toContain("Step 1");
    expect(card().textContent).not.toContain("Step 3");
  });

  it("opens into the full list on click and folds again", () => {
    render({
      items: items("completed", "in_progress", "pending"),
      explanation: "Fixing the build",
    });
    expect(card().textContent).not.toContain("Fixing the build");

    act(() => fold().click());
    expect(card().getAttribute("data-task-list")).toBe("open");
    expect(fold().getAttribute("aria-expanded")).toBe("true");
    expect(
      [...card().querySelectorAll("ol > li")].map((row) => row.textContent),
    ).toEqual(["Step 1", "Step 2", "Step 3"]);
    // The list itself now says which step is running.
    expect(card().querySelector("[data-task-list-current]")).toBeNull();
    expect(card().textContent).toContain("Fixing the build");
    expect(fold().getAttribute("aria-controls")).toBe(
      card().querySelector("ol")?.parentElement?.id,
    );

    act(() => fold().click());
    expect(card().querySelector("ol")).toBeNull();
    expect(card().querySelector("[data-task-list-current]")?.textContent).toBe(
      "Step 2",
    );
  });

  it("names the next step when none is running, and none when done", () => {
    render({ items: items("completed", "pending", "pending") });
    expect(card().querySelector("[data-task-list-current]")?.textContent).toBe(
      "Step 2",
    );
    expect(
      card().querySelector('[data-task-list-current] [aria-label="Pending"]'),
    ).not.toBeNull();

    render({ items: items("completed", "completed") });
    expect(card().querySelector("[data-task-list-current]")).toBeNull();
    expect(card().textContent).toContain("Complete");
  });

  it("follows the agent to the next step while folded", () => {
    render({ items: items("in_progress", "pending") });
    expect(card().querySelector("[data-task-list-current]")?.textContent).toBe(
      "Step 1",
    );
    render({ items: items("completed", "in_progress") });
    expect(card().querySelector("[data-task-list-current]")?.textContent).toBe(
      "Step 2",
    );
    expect(card().textContent).toContain("1 of 2");
  });

  it("is still open when its row is drawn again", () => {
    const list = items("completed", "in_progress");
    render({ items: list, listKey: "plan-1" });
    act(() => fold().click());

    // The transcript unmounts rows it scrolls away from.
    act(() => root.unmount());
    root = createRoot(container);
    render({ items: list, listKey: "plan-1" });
    expect(card().getAttribute("data-task-list")).toBe("open");

    // Another list is its own card, and starts folded.
    render({ items: list, listKey: "plan-2" });
    act(() => root.unmount());
    root = createRoot(container);
    render({ items: list, listKey: "plan-2" });
    expect(card().getAttribute("data-task-list")).toBe("folded");
  });

  it("forgets a card that was folded again", () => {
    const list = items("in_progress");
    render({ items: list, listKey: "plan-1" });
    act(() => fold().click());
    act(() => fold().click());
    act(() => root.unmount());
    root = createRoot(container);
    render({ items: list, listKey: "plan-1" });
    expect(card().getAttribute("data-task-list")).toBe("folded");
  });
});
