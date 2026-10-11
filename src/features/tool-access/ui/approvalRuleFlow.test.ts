// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
let onLine: (line: string) => void;
vi.mock("../../../integrations/harness/core/existingDirs", () => ({
  existingDirs: async (dirs?: readonly string[]) => [...(dirs ?? [])],
}));
vi.mock("../../../integrations/harness/core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
}));

import {
  appendUser,
  applyHarnessEvent,
} from "../../../integrations/harness/core/apply";
import {
  registerHarness,
  respondHarnessApproval,
  setHarnessToolAccess,
} from "../../../integrations/harness/core/registry";
import type { HarnessEvent } from "../../../integrations/harness/core/types";
import {
  sessionToolsInput,
  withSessionToolsPatch,
} from "../../session-tools/model/harnessInput";
import { newSession, type Session } from "../../sessions/model/session";
import { useSessionApprovalRules } from "./approvalRules";
import { TranscriptWithApprovalRules } from "./TranscriptWithApprovalRules";

const { claudeAdapter } =
  await import("../../../integrations/harness/providers/claude/claudeAdapter");
const { __claudeTestReset, stopClaudeSession } =
  await import("../../../integrations/harness/providers/claude/claude");
const { claudeBlockedToolMessage } =
  await import("../../../integrations/harness/providers/claude/claudeProtocol");

let container: HTMLDivElement;
let root: Root;
let session: Session;
let turn: Promise<void>;

function parse() {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const answerTo = (requestId: string) =>
  (
    parse().find(
      (m) => (m.response as Record<string, unknown>)?.request_id === requestId,
    )?.response as { response?: Record<string, unknown> } | undefined
  )?.response;

/** The pane, wired to the harness the way the app wires it. */
function Pane({ current }: { current: Session }) {
  const rules = useSessionApprovalRules(
    current.harness,
    current.toolAccess,
    (toolAccess) => {
      session = withSessionToolsPatch(session, { toolAccess });
      setHarnessToolAccess(
        session.harness,
        session.id,
        sessionToolsInput(session, session.cwd).toolAccess,
      );
      render();
    },
  );
  return createElement(TranscriptWithApprovalRules, {
    approvalRules: rules,
    blocks: current.blocks,
    busy: true,
    onApproval: (id, decision) =>
      respondHarnessApproval(current.harness, current.id, id, decision),
  });
}

function render(event?: HarnessEvent) {
  if (event) session = applyHarnessEvent(session, event);
  root.render(createElement(Pane, { current: session }));
}

function ask(requestId: string, toolName: string, input: object) {
  onLine(
    JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "can_use_tool",
        tool_name: toolName,
        tool_use_id: `use_${requestId}`,
        input,
      },
    }),
  );
}

const ruleMenu = () =>
  container.querySelector<HTMLButtonElement>("[data-approval-rule-menu]");

async function pick(entry: "Always" | "Never") {
  await act(async () => ruleMenu()!.click());
  const item = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="menu"] button'),
  ).find((button) => button.textContent?.startsWith(entry))!;
  await act(async () => item.click());
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sent.length = 0;
  __claudeTestReset();
  registerHarness(claudeAdapter);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  session = appendUser(
    newSession("claude", "/repo", "claude:claude-sonnet-5", "supervised"),
    "run the tests",
  );
  session.id = "rules-ui";
  session.busy = true;
  await act(async () => {
    turn = claudeAdapter.sendTurn({
      sessionId: session.id,
      cwd: session.cwd,
      model: session.model,
      runtimeMode: session.runtimeMode,
      ...sessionToolsInput(session, session.cwd),
      text: "run the tests",
      onEvent: render,
    });
    await vi.waitFor(() =>
      expect(
        parse().some(
          (m) =>
            (m.request as Record<string, unknown> | undefined)?.subtype ===
            "initialize",
        ),
      ).toBe(true),
    );
    onLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess_1" }),
    );
    await vi.waitFor(() =>
      expect(parse().some((m) => m.type === "user")).toBe(true),
    );
  });
});

afterEach(async () => {
  await act(async () => {
    onLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "sess_1",
      }),
    );
    await turn;
    await stopClaudeSession(session.id);
    root.unmount();
  });
  container.remove();
  __claudeTestReset();
  vi.unstubAllGlobals();
});

describe("a rule chosen on a Claude Code approval card", () => {
  it("blocks the tool: the request and the next one are refused, with the reason", async () => {
    await act(async () => ask("r1", "Bash", { command: "npm test" }));
    expect(ruleMenu()).not.toBeNull();
    await pick("Never");
    await vi.waitFor(() => expect(answerTo("r1")).toBeDefined());
    expect(answerTo("r1")).toEqual({
      behavior: "deny",
      message: claudeBlockedToolMessage("Bash"),
    });
    expect(session.toolAccess).toEqual({ Bash: "never" });
    // The card is settled.
    await act(async () => {});
    expect(ruleMenu()).toBeNull();
    expect(container.textContent).not.toContain("Allow");

    await act(async () => ask("r2", "Bash", { command: "npm run build" }));
    await vi.waitFor(() => expect(answerTo("r2")).toBeDefined());
    expect(answerTo("r2")).toEqual({
      behavior: "deny",
      message: claudeBlockedToolMessage("Bash"),
    });
    expect(ruleMenu()).toBeNull();
  });

  it("always allows the tool: this request and the next one, with no second card", async () => {
    await act(async () => ask("r1", "Bash", { command: "npm test" }));
    await pick("Always");
    await vi.waitFor(() => expect(answerTo("r1")).toBeDefined());
    expect(answerTo("r1")).toMatchObject({ behavior: "allow" });
    expect(session.toolAccess).toEqual({ Bash: "always" });

    await act(async () => ask("r2", "Bash", { command: "npm run build" }));
    await vi.waitFor(() => expect(answerTo("r2")).toBeDefined());
    expect(answerTo("r2")).toMatchObject({ behavior: "allow" });
    expect(ruleMenu()).toBeNull();

    // Another tool still gets its card.
    await act(async () =>
      ask("r3", "Write", { file_path: "/repo/a.txt", content: "x" }),
    );
    expect(ruleMenu()?.getAttribute("aria-label")).toBe(
      "Remember a choice for Write",
    );
    expect(answerTo("r3")).toBeUndefined();
    const deny = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Deny",
    )!;
    await act(async () => deny.click());
    await vi.waitFor(() => expect(answerTo("r3")).toBeDefined());
  });
});
