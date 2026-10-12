// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../sessions/model/session";

const gitDiffStats = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/tauri/fs", () => ({ gitDiffStats }));

import {
  dismissSuggestions,
  suggestPrompts,
  suggestionsDismissed,
  SUGGESTIONS_MAX,
} from "./suggestions";
import { SuggestedPromptChips } from "../ui/SuggestedPromptChips";
import { useSuggestedPrompts } from "../hooks/useSuggestedPrompts";

const user = (id: string): Block => ({ id, role: "user", text: "go" });
const command = (id: string, status: string, title = "npm test"): Block => ({
  id,
  role: "tool",
  text: "",
  tool: { kind: "execute", status, title },
});
const none = { changes: null };

describe("suggestPrompts (#46)", () => {
  it("offers a fix for a command that failed in the last turn", () => {
    const [chip] = suggestPrompts({
      blocks: [
        user("u"),
        command("c", "failed", "npm run test -- --watch=false"),
      ],
      busy: false,
      hasDraft: false,
      state: none,
    });
    expect(chip?.id).toBe("failed-command");
    expect(chip?.prompt).toContain("`npm run test -- --watch=false`");
  });

  it("ignores a failure that a later command in the turn fixed, or an older turn's", () => {
    expect(
      suggestPrompts({
        blocks: [user("u"), command("a", "failed"), command("b", "completed")],
        busy: false,
        hasDraft: false,
        state: none,
      }),
    ).toEqual([]);
    expect(
      suggestPrompts({
        blocks: [user("u1"), command("a", "failed"), user("u2")],
        busy: false,
        hasDraft: false,
        state: none,
      }),
    ).toEqual([]);
  });

  it("cuts a long command and keeps it from closing the code span", () => {
    const [chip] = suggestPrompts({
      blocks: [
        user("u"),
        command("c", "error", `echo ${"x".repeat(200)} \`id\``),
      ],
      busy: false,
      hasDraft: false,
      state: none,
    });
    const inner = chip!.prompt.match(/`([^`]*)`/)![1]!;
    expect(inner.length).toBeLessThanOrEqual(80);
    expect(chip!.prompt.split("`").length).toBe(3);
  });

  it("offers open tasks, else an approved-ready plan", () => {
    const tasks: Block = {
      id: "t",
      role: "assistant",
      text: "",
      taskList: {
        items: [
          { text: "a", status: "completed" },
          { text: "b", status: "in_progress" },
          { text: "c", status: "pending" },
        ],
      },
    };
    expect(
      suggestPrompts({
        blocks: [tasks],
        busy: false,
        hasDraft: false,
        state: none,
      })[0]?.label,
    ).toBe("Finish the 2 open tasks");
    const plan: Block = {
      id: "p",
      role: "assistant",
      text: "1. do it",
      plan: { status: "ready" },
    };
    expect(
      suggestPrompts({
        blocks: [plan],
        busy: false,
        hasDraft: false,
        state: none,
      })[0]?.id,
    ).toBe("unbuilt-plan");
    expect(
      suggestPrompts({
        blocks: [{ ...plan, plan: { status: "built" } }],
        busy: false,
        hasDraft: false,
        state: none,
      }),
    ).toEqual([]);
  });

  it("offers a review of uncommitted changes, and caps at three chips", () => {
    const blocks: Block[] = [
      user("u"),
      command("c", "failed"),
      { id: "p", role: "assistant", text: "", plan: { status: "ready" } },
    ];
    const chips = suggestPrompts({
      blocks,
      busy: false,
      hasDraft: false,
      state: { changes: { files: 1, additions: 3, deletions: 0 } },
    });
    expect(chips.map((c) => c.id)).toEqual([
      "failed-command",
      "unbuilt-plan",
      "changes",
    ]);
    expect(chips.at(-1)!.label).toBe("Review 1 changed file");
    expect(chips.length).toBeLessThanOrEqual(SUGGESTIONS_MAX);
  });

  it("shows nothing while a turn runs or the user has typed", () => {
    const state = { changes: { files: 4, additions: 1, deletions: 1 } };
    expect(
      suggestPrompts({ blocks: [], busy: true, hasDraft: false, state }),
    ).toEqual([]);
    expect(
      suggestPrompts({ blocks: [], busy: false, hasDraft: true, state }),
    ).toEqual([]);
    expect(
      suggestPrompts({
        blocks: [],
        busy: false,
        hasDraft: false,
        state: { changes: { files: 0, additions: 0, deletions: 0 } },
      }),
    ).toEqual([]);
  });
});

describe("dismissing", () => {
  beforeEach(() => window.localStorage.clear());

  it("hides the chips per chat, and survives bad stored data", () => {
    expect(suggestionsDismissed("s1")).toBe(false);
    dismissSuggestions("s1");
    expect(suggestionsDismissed("s1")).toBe(true);
    expect(suggestionsDismissed("s2")).toBe(false);
    window.localStorage.setItem("monocode:suggested-prompts:off", "{not json");
    expect(suggestionsDismissed("s1")).toBe(false);
    dismissSuggestions("s3");
    expect(suggestionsDismissed("s3")).toBe(true);
  });
});

describe("the chips", () => {
  it("render labels, put the full prompt in the title, and escape text", () => {
    const html = renderToStaticMarkup(
      createElement(SuggestedPromptChips, {
        prompts: [
          {
            id: "failed-command",
            label: "Fix the failing command",
            prompt: "The last command failed: `<b>x</b>`.",
          },
        ],
        onPick: () => {},
        onDismiss: () => {},
      }),
    );
    expect(html).toContain("Fix the failing command");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>");
    expect(html).toContain("Hide suggestions in this chat");
  });

  it("render nothing with no prompts", () => {
    expect(
      renderToStaticMarkup(
        createElement(SuggestedPromptChips, {
          prompts: [],
          onPick: () => {},
          onDismiss: () => {},
        }),
      ),
    ).toBe("");
  });
});

describe("useSuggestedPrompts", () => {
  function mount(props: Parameters<typeof useSuggestedPrompts>[0]) {
    const seen: ReturnType<typeof useSuggestedPrompts>[] = [];
    function Probe(p: typeof props) {
      seen.push(useSuggestedPrompts(p));
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Probe, props)));
    return { seen, root, Probe };
  }

  beforeEach(() => {
    window.localStorage.clear();
    gitDiffStats.mockReset();
    vi.useFakeTimers();
  });

  it("reads git once the chat is idle and shows the changes chip", async () => {
    gitDiffStats.mockResolvedValue({ files: 2, additions: 5, deletions: 1 });
    const { seen, root } = mount({
      sessionId: "s",
      workCwd: "/Users/tony/code/app",
      blocks: [],
      busy: false,
      remote: false,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(gitDiffStats).toHaveBeenCalledWith("/Users/tony/code/app");
    expect(seen.at(-1)!.prompts.map((p) => p.id)).toEqual(["changes"]);
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("never reads git for a remote chat, a busy one, or a folder that is not a project", async () => {
    for (const props of [
      { workCwd: "/Users/tony/code/app", busy: false, remote: true },
      { workCwd: "/Users/tony/code/app", busy: true, remote: false },
      { workCwd: "~", busy: false, remote: false },
    ]) {
      const { root } = mount({ sessionId: "s", blocks: [], ...props });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      act(() => root.unmount());
    }
    expect(gitDiffStats).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("treats a git error as no changes, not a crash", async () => {
    gitDiffStats.mockRejectedValue("not a git repository");
    const { seen, root } = mount({
      sessionId: "s",
      workCwd: "/Users/tony/scratch",
      blocks: [],
      busy: false,
      remote: false,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(seen.at(-1)!.prompts).toEqual([]);
    act(() => root.unmount());
    vi.useRealTimers();
  });
});
