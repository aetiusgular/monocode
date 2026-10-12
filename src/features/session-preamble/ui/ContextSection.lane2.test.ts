// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextSectionView, preambleSummary } from "./ContextSection";
import type { PreambleReport } from "../model/chatContext";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  // The section starts folded; open it for the test.
  localStorage.setItem("monocode.sessionPanel.contextCollapsed", "false");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const report: PreambleReport = {
  channel: "message",
  chars: 3_000,
  budget: 3_276,
  included: ["instructions", "memory"],
  omitted: [{ id: "memory", label: "Project memory", chars: 900, lines: 12 }],
  overBudget: false,
  at: 0,
};

function render(props: Partial<Parameters<typeof ContextSectionView>[0]> = {}) {
  const calls = {
    memoryOff: [] as boolean[],
    resend: 0,
    accept: [] as string[],
    reject: [] as string[],
  };
  act(() =>
    root.render(
      createElement(ContextSectionView, {
        report,
        memoryOff: false,
        proposals: [],
        resent: false,
        onMemoryOff: (off) => calls.memoryOff.push(off),
        onResend: () => calls.resend++,
        onAccept: (id) => calls.accept.push(id),
        onReject: (id) => calls.reject.push(id),
        ...props,
      }),
    ),
  );
  return calls;
}

describe("F2: the Context section", () => {
  it("says how it went and what did not fit (corner case 1)", () => {
    render();
    const text = container.textContent ?? "";
    expect(text).toContain("Sent ahead of the last message");
    expect(text).toContain("3,000 of 3,276 characters, about 750 tokens");
    expect(text).toContain("Project memory: 12 entries did not fit");
  });

  it("switches memory off for the chat and asks to send again", () => {
    const calls = render();
    act(() =>
      (
        container.querySelector("[data-context-memory]") as HTMLInputElement
      ).click(),
    );
    expect(calls.memoryOff).toEqual([true]);
    act(() =>
      (
        container.querySelector("[data-context-resend]") as HTMLButtonElement
      ).click(),
    );
    expect(calls.resend).toBe(1);
  });

  it("shows memory waiting for a click, marked local", () => {
    const calls = render({
      proposals: [
        {
          id: "p1",
          fact: "Tests use vitest",
          local: true,
          source: "agent",
          at: 0,
        },
      ],
    });
    expect(container.textContent).toContain("Tests use vitest");
    expect(container.textContent).toContain("(local only)");
    act(() =>
      (
        container.querySelector("[data-proposal-accept]") as HTMLButtonElement
      ).click(),
    );
    act(() =>
      (
        container.querySelector("[data-proposal-reject]") as HTMLButtonElement
      ).click(),
    );
    expect(calls.accept).toEqual(["p1"]);
    expect(calls.reject).toEqual(["p1"]);
  });

  it("offers Suggest memories unless memory is off (#36)", () => {
    let asked = 0;
    render({ onSuggest: () => asked++, suggestNote: "2 waiting below." });
    act(() =>
      (
        container.querySelector("[data-context-suggest]") as HTMLButtonElement
      ).click(),
    );
    expect(asked).toBe(1);
    expect(container.textContent).toContain("2 waiting below.");
    render({ onSuggest: () => asked++, memoryOff: true });
    expect(container.querySelector("[data-context-suggest]")).toBeNull();
    render({ onSuggest: () => asked++, suggesting: true });
    expect(container.textContent).toContain("Asking the chat's model");
  });

  it("flags app access over budget", () => {
    render({ report: { ...report, overBudget: true } });
    expect(container.querySelector("[data-context-over]")).not.toBeNull();
  });

  it("summarizes the other channels", () => {
    expect(preambleSummary(undefined)).toContain("Nothing sent yet");
    expect(preambleSummary({ ...report, channel: "none" })).toBe(
      "Nothing to send",
    );
    expect(preambleSummary({ ...report, channel: "native" })).toContain(
      "Given at launch",
    );
    expect(preambleSummary({ ...report, channel: "unchanged" })).toContain(
      "Already with the agent",
    );
  });
});
