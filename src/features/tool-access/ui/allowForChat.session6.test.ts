// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block, Session } from "../../sessions/model/session";
import { newSession } from "../../sessions/model/session";
import { AllowForChatButton, allowForChatPlan } from "./AllowForChatButton";
import { ApprovalRuleMenu } from "./ApprovalRuleMenu";
import { ApprovalRulesContext, type ApprovalRules } from "./approvalRules";
import { setToolChoice, toolKeyApplies } from "../model/toolAccess";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
const { getSession, sanitizeSessionForPersist } =
  await import("../../sessions/data/sessionStore");

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

type Approval = NonNullable<Block["approval"]>;

const BASH_CARD: Approval = {
  requestId: 4,
  tool: { key: "Bash", label: "Bash" },
  chatRule: { key: "Bash(npm test *)", label: "Bash: npm test commands" },
};

function claudeRules() {
  const value: ApprovalRules = {
    applies: (key) => toolKeyApplies("claude", key),
    remember: vi.fn(),
  };
  return value;
}

function render(
  element: ReturnType<typeof createElement>,
  value: ApprovalRules | null,
) {
  act(() =>
    root.render(
      createElement(ApprovalRulesContext.Provider, { value }, element),
    ),
  );
}
const button = () =>
  container.querySelector<HTMLButtonElement>("[data-allow-for-chat]");

describe("Allow for this chat on a command card (11.T2.2)", () => {
  it("keeps the command's prefix rule on Claude Code, never the whole Bash tool", () => {
    const rules = claudeRules();
    const onApproval = vi.fn();
    render(
      createElement(AllowForChatButton, { approval: BASH_CARD, onApproval }),
      rules,
    );
    // Security fix F1: the button names the rule it keeps.
    expect(button()?.textContent).toBe("Allow npm test in this chat");
    expect(button()?.querySelector("code")?.textContent).toBe("npm test");
    expect(button()?.title).toBe(
      'Allow commands that start with "npm test" in this chat, also after a restart. Any other command still asks.',
    );
    act(() => button()!.click());
    expect(rules.remember).toHaveBeenCalledTimes(1);
    expect(rules.remember).toHaveBeenCalledWith(BASH_CARD.chatRule, "always");
    expect(rules.remember).not.toHaveBeenCalledWith(BASH_CARD.tool, "always");
    expect(onApproval).toHaveBeenCalledWith(4, "allow", { forChat: true });
  });

  it("names an exact rule for a command that has no prefix", () => {
    expect(
      allowForChatPlan({
        ...BASH_CARD,
        chatRule: {
          key: "Bash(seq 1 3000)",
          label: "Bash: the command seq 1 3000",
        },
      })?.title,
    ).toBe(
      'Allow the command "seq 1 3000" in this chat, also after a restart. Any other command still asks.',
    );
  });

  it("is not offered for a Bash card with no command rule", () => {
    render(
      createElement(AllowForChatButton, {
        approval: { ...BASH_CARD, chatRule: undefined },
        onApproval: vi.fn(),
      }),
      claudeRules(),
    );
    expect(button()).toBeNull();
  });

  it("stays acceptForSession on Codex commands, with no rule kept", () => {
    const remember = vi.fn();
    const onApproval = vi.fn();
    render(
      createElement(AllowForChatButton, {
        approval: {
          requestId: 9,
          tool: { key: "codex:command", label: "Commands" },
        },
        onApproval,
      }),
      { applies: (key) => toolKeyApplies("codex", key), remember },
    );
    expect(button()?.title).toContain("this exact command only");
    act(() => button()!.click());
    expect(remember).not.toHaveBeenCalled();
    expect(onApproval).toHaveBeenCalledWith(9, "allow", { forChat: true });
  });

  it("keeps the tool rule for file edits and other tools", () => {
    const edit: Approval = {
      requestId: 5,
      tool: { key: "Edit", label: "Edit" },
    };
    expect(allowForChatPlan(edit)?.keep).toEqual(edit.tool);
    const patch: Approval = {
      requestId: 6,
      tool: { key: "codex:file-change", label: "File edits" },
    };
    expect(allowForChatPlan(patch)?.keep).toEqual(patch.tool);
  });

  it("leaves the explicit whole-tool choice in the menu", () => {
    const rules = claudeRules();
    const onApproval = vi.fn();
    render(
      createElement(ApprovalRuleMenu, { approval: BASH_CARD, onApproval }),
      rules,
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>("[data-approval-rule-menu]")!
        .click(),
    );
    const item = [
      ...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]"),
    ].find((b) => b.textContent === "Always allow Bash in this chat")!;
    act(() => item.click());
    expect(rules.remember).toHaveBeenCalledWith(BASH_CARD.tool, "always");
    expect(onApproval).toHaveBeenCalledWith(4, "allow", { forChat: true });
  });
});

describe("a command rule across a restart", () => {
  beforeEach(() => invoke.mockReset());

  it("is saved on the chat and comes back from its first user block", async () => {
    const live: Session = {
      ...newSession("claude", "/repo"),
      id: "s1",
      blocks: [{ id: "u1", role: "user", text: "run the tests" }],
      toolAccess: setToolChoice(undefined, "Bash(npm test *)", "always"),
    };
    const saved = JSON.parse(JSON.stringify(sanitizeSessionForPersist(live)));
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "session_get" ? saved : null),
    );
    const restored = await getSession("s1");
    expect(restored?.toolAccess).toEqual({ "Bash(npm test *)": "always" });
    // The whole Bash tool is not allowed.
    expect(restored?.toolAccess).not.toHaveProperty("Bash");
  });
});
