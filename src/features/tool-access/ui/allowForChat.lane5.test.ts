// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../sessions/model/session";
import { ApprovalControls } from "../../sessions/ui/AgentTranscript";
import { AllowForChatButton } from "./AllowForChatButton";
import { ApprovalRuleMenu } from "./ApprovalRuleMenu";
import { ApprovalRulesContext, type ApprovalRules } from "./approvalRules";

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

const EDIT: Approval = {
  requestId: 7,
  kind: "edit",
  tool: { key: "codex:file-change", label: "File edits" },
} as Approval;

function rules(applies = true) {
  const order: string[] = [];
  const value: ApprovalRules = {
    applies: () => applies,
    remember: vi.fn(() => {
      order.push("remember");
    }),
  };
  return { value, order };
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

describe("Allow for this chat", () => {
  it("saves the chat's always rule, then allows with forChat", () => {
    const { value, order } = rules();
    const onApproval = vi.fn(() => {
      order.push("answer");
    });
    render(
      createElement(AllowForChatButton, { approval: EDIT, onApproval }),
      value,
    );
    expect(button()?.textContent).toBe("Allow for this chat");
    act(() => button()!.click());
    expect(value.remember).toHaveBeenCalledWith(EDIT.tool, "always");
    expect(onApproval).toHaveBeenCalledWith(7, "allow", { forChat: true });
    expect(order).toEqual(["remember", "answer"]);
  });

  it("is not shown where the chat keeps no rules, or for this tool", () => {
    render(
      createElement(AllowForChatButton, {
        approval: EDIT,
        onApproval: vi.fn(),
      }),
      null,
    );
    expect(button()).toBeNull();
    render(
      createElement(AllowForChatButton, {
        approval: EDIT,
        onApproval: vi.fn(),
      }),
      rules(false).value,
    );
    expect(button()).toBeNull();
  });

  it("is not shown for a request with no tool, or a network request", () => {
    const { value } = rules();
    const noTool = { ...EDIT, tool: undefined } as Approval;
    render(
      createElement(AllowForChatButton, {
        approval: noTool,
        onApproval: vi.fn(),
      }),
      value,
    );
    expect(button()).toBeNull();
    const network = {
      ...EDIT,
      tool: { key: "codex:command", label: "Commands" },
      network: { host: "example.com", protocol: "https" },
    } as Approval;
    render(
      createElement(AllowForChatButton, {
        approval: network,
        onApproval: vi.fn(),
      }),
      value,
    );
    expect(button()).toBeNull();
  });

  it("sits on the card between Allow and Deny", () => {
    const block = { id: "b", kind: "tool", approval: EDIT } as unknown as Block;
    render(
      createElement(ApprovalControls, { block, onApproval: vi.fn() }),
      rules().value,
    );
    const labels = [...container.querySelectorAll("button")].map(
      (b) => b.textContent,
    );
    expect(labels.slice(0, 3)).toEqual([
      "Allow",
      "Allow for this chat",
      "Deny",
    ]);
  });

  it("the menu's Always allow also sends forChat; Never does not", () => {
    const { value } = rules();
    const onApproval = vi.fn();
    render(
      createElement(ApprovalRuleMenu, { approval: EDIT, onApproval }),
      value,
    );
    const open = () =>
      act(() =>
        container
          .querySelector<HTMLButtonElement>("[data-approval-rule-menu]")!
          .click(),
      );
    const pick = (text: string) =>
      act(() =>
        [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")]
          .find((b) => b.textContent?.startsWith(text))!
          .click(),
      );
    open();
    pick("Always allow");
    expect(onApproval).toHaveBeenLastCalledWith(7, "allow", { forChat: true });
    open();
    pick("Never allow");
    expect(onApproval).toHaveBeenLastCalledWith(7, "deny");
  });
});
