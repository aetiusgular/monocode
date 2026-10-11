// @vitest-environment happy-dom
import { act, createElement, Fragment, useCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendUser,
  applyHarnessEvent,
} from "../../../integrations/harness/core/apply";
import type {
  ApprovalDecision,
  HarnessEvent,
} from "../../../integrations/harness/core/types";
import {
  newSession,
  type ApprovalTool,
  type HarnessId,
  type Session,
  type ToolAccess,
} from "../../sessions/model/session";
import { AgentTranscript } from "../../sessions/ui/AgentTranscript";
import {
  PooledTranscript,
  TranscriptPool,
  TranscriptPoolOutlet,
} from "../../sessions/ui/TranscriptPool";
import { useSessionApprovalRules } from "./approvalRules";
import { TranscriptWithApprovalRules } from "./TranscriptWithApprovalRules";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const BASH: ApprovalTool = { key: "Bash", label: "Bash" };

function sessionWithCard(
  harness: HarnessId,
  tool?: ApprovalTool,
  toolAccess?: ToolAccess,
): Session {
  const asked: HarnessEvent = {
    type: "approval.requested",
    requestId: 7,
    title: "npm test",
    kind: "execute",
    callId: "call_1",
    ...(tool ? { tool } : {}),
  };
  return {
    ...applyHarnessEvent(appendUser(newSession(harness, "/repo"), "go"), asked),
    busy: true,
    toolAccess,
  };
}

type Calls = Array<["rule", ToolAccess] | ["answer", number, ApprovalDecision]>;

function Pane({
  session,
  calls,
  saved = true,
}: {
  session: Session;
  calls: Calls;
  /** False where the chat's rules cannot be saved. */
  saved?: boolean;
}) {
  const rules = useSessionApprovalRules(
    session.harness,
    session.toolAccess,
    saved ? (toolAccess) => calls.push(["rule", toolAccess]) : undefined,
  );
  return createElement(TranscriptWithApprovalRules, {
    approvalRules: rules,
    blocks: session.blocks,
    busy: true,
    onApproval: (id, decision) => calls.push(["answer", id, decision]),
  });
}

async function renderPane(
  session: Session,
  options: { saved?: boolean } = {},
): Promise<Calls> {
  const calls: Calls = [];
  await act(async () =>
    root.render(createElement(Pane, { session, calls, ...options })),
  );
  return calls;
}

const opener = () =>
  container.querySelector<HTMLButtonElement>("[data-approval-rule-menu]");
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const entries = () =>
  Array.from(menu()?.querySelectorAll<HTMLButtonElement>("button") ?? []);
const buttons = () =>
  Array.from(container.querySelectorAll("button")).map((button) =>
    button.textContent?.trim(),
  );

describe("the rule menu on an approval card", () => {
  it("sits beside Allow and Deny and offers the two rules by name", async () => {
    await renderPane(sessionWithCard("claude", BASH));
    expect(buttons()).toEqual(expect.arrayContaining(["Allow", "Deny"]));
    expect(opener()?.getAttribute("aria-label")).toBe(
      "Remember a choice for Bash",
    );
    expect(opener()?.getAttribute("aria-expanded")).toBe("false");
    expect(menu()).toBeNull();

    await act(async () => opener()!.click());
    expect(opener()?.getAttribute("aria-expanded")).toBe("true");
    expect(entries().map((entry) => entry.textContent)).toEqual([
      "Always allow Bash in this chat",
      "Never allow Bash in this chat",
    ]);
    expect(entries().every((entry) => entry.type === "button")).toBe(true);
  });

  it("stores an always rule, then allows the request", async () => {
    const calls = await renderPane(
      sessionWithCard("claude", BASH, { WebFetch: "never" }),
    );
    await act(async () => opener()!.click());
    await act(async () => entries()[0].click());
    expect(calls).toEqual([
      ["rule", { WebFetch: "never", Bash: "always" }],
      ["answer", 7, "allow"],
    ]);
    expect(menu()).toBeNull();
  });

  it("stores a never rule, then denies the request", async () => {
    const calls = await renderPane(sessionWithCard("claude", BASH));
    await act(async () => opener()!.click());
    await act(async () => entries()[1].click());
    expect(calls).toEqual([
      ["rule", { Bash: "never" }],
      ["answer", 7, "deny"],
    ]);
  });

  it("names a Codex request in words", async () => {
    const calls = await renderPane(
      sessionWithCard("codex", {
        key: "codex:file-change",
        label: "File edits",
      }),
    );
    await act(async () => opener()!.click());
    expect(entries()[1].textContent).toBe(
      "Never allow File edits in this chat",
    );
    await act(async () => entries()[1].click());
    expect(calls).toEqual([
      ["rule", { "codex:file-change": "never" }],
      ["answer", 7, "deny"],
    ]);
  });

  it("closes on Escape and gives focus back to its button", async () => {
    await renderPane(sessionWithCard("claude", BASH));
    await act(async () => opener()!.click());
    expect(menu()).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(opener());
  });

  it("closes on a click outside without answering", async () => {
    const calls = await renderPane(sessionWithCard("claude", BASH));
    await act(async () => opener()!.click());
    await act(async () => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(menu()).toBeNull();
    expect(calls).toEqual([]);
  });

  it("leaves Allow and Deny answering once, with no rule", async () => {
    const calls = await renderPane(sessionWithCard("claude", BASH));
    const allow = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Allow",
    )!;
    await act(async () => allow.click());
    expect(calls).toEqual([["answer", 7, "allow"]]);
  });
});

describe("where the card offers no rule menu", () => {
  it("is absent when the request names no tool", async () => {
    await renderPane(sessionWithCard("claude"));
    expect(buttons()).toEqual(expect.arrayContaining(["Allow", "Deny"]));
    expect(opener()).toBeNull();
  });

  it("is absent on a harness that keeps no tool rules", async () => {
    await renderPane(sessionWithCard("cursor", BASH));
    expect(opener()).toBeNull();
  });

  it("is absent for a tool the session's harness cannot answer for", async () => {
    // A Claude Code tool name on a session that now runs Codex.
    await renderPane(sessionWithCard("codex", BASH));
    expect(opener()).toBeNull();
  });

  it("is absent where the chat's rules cannot be saved", async () => {
    await renderPane(sessionWithCard("claude", BASH), { saved: false });
    expect(buttons()).toEqual(expect.arrayContaining(["Allow", "Deny"]));
    expect(opener()).toBeNull();
  });

  it("is absent without the provider, as in a host session", async () => {
    const session = sessionWithCard("claude", BASH);
    await act(async () =>
      root.render(
        createElement(AgentTranscript, {
          blocks: session.blocks,
          busy: true,
          onApproval: () => undefined,
        }),
      ),
    );
    expect(buttons()).toEqual(expect.arrayContaining(["Allow", "Deny"]));
    expect(opener()).toBeNull();
  });

  it("goes away with the card once the request is answered", async () => {
    const session = sessionWithCard("claude", BASH);
    await renderPane({
      ...session,
      ...applyHarnessEvent(session, {
        type: "approval.resolved",
        requestId: 7,
        decision: "allow",
      }),
    });
    expect(opener()).toBeNull();
    expect(buttons()).not.toContain("Allow");
  });
});

describe("a transcript shown through the transcript pool", () => {
  it("still reaches its chat's rules, and survives being parked", async () => {
    // The pool renders the transcript outside the pane's own tree, sets
    // `visible` and `parked` on it, and compares its props between renders.
    const pool = new TranscriptPool();
    const session = sessionWithCard("claude", BASH);
    const calls: Calls = [];
    const emitted = vi.fn();
    pool.subscribe(emitted);
    function PooledPane({ shown }: { shown: boolean }) {
      const rules = useSessionApprovalRules(
        session.harness,
        session.toolAccess,
        (toolAccess) => calls.push(["rule", toolAccess]),
      );
      const approve = useCallback(
        (id: number, decision: ApprovalDecision) =>
          calls.push(["answer", id, decision]),
        [],
      );
      return createElement(
        Fragment,
        null,
        shown
          ? createElement(PooledTranscript, {
              pool,
              sessionId: session.id,
              children: createElement(TranscriptWithApprovalRules, {
                approvalRules: rules,
                blocks: session.blocks,
                busy: true,
                onApproval: approve,
              }),
            })
          : null,
        createElement(TranscriptPoolOutlet, { pool }),
      );
    }
    await act(async () =>
      root.render(createElement(PooledPane, { shown: true })),
    );
    expect(opener()).not.toBeNull();
    // A second render with the same props is not a new transcript to the pool.
    const shows = emitted.mock.calls.length;
    await act(async () =>
      root.render(createElement(PooledPane, { shown: true })),
    );
    expect(emitted.mock.calls.length).toBe(shows);

    await act(async () => opener()!.click());
    await act(async () => entries()[0].click());
    expect(calls).toEqual([
      ["rule", { Bash: "always" }],
      ["answer", 7, "allow"],
    ]);

    // Parking clones the element with `parked`; that must not throw.
    await act(async () =>
      root.render(createElement(PooledPane, { shown: false })),
    );
    expect(container.querySelector("[data-approval-rule-menu]")).toBeNull();
  });
});

describe("the context value", () => {
  it("keeps its identity while the rules change", async () => {
    const seen: unknown[] = [];
    function Probe({ toolAccess }: { toolAccess?: ToolAccess }) {
      seen.push(useSessionApprovalRules("claude", toolAccess, () => undefined));
      return null;
    }
    await act(async () => root.render(createElement(Probe, {})));
    await act(async () =>
      root.render(createElement(Probe, { toolAccess: { Bash: "always" } })),
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBeNull();
    expect(seen[1]).toBe(seen[0]);
  });
});
