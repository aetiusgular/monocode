// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  newSession,
  type Block,
  type Session,
  type TaskListItemStatus,
} from "../../sessions/model/session";
import type { DocumentFile } from "../../file-cards/model/documentFiles";
import {
  SESSION_PANEL_MIN_PANE_WIDTH,
  SESSION_PANEL_MIN_TRANSCRIPT_WIDTH,
  SESSION_PANEL_WIDTH,
} from "../model/sessionPanelState";
import { SessionPanel, SessionPanelView } from "./SessionPanel";
import { SessionPanelSlot } from "./SessionPanelSlot";
import { SessionPanelToggle } from "./SessionPanelToggle";
import { useSessionPanel, type SessionPanelControl } from "./useSessionPanel";

let container: HTMLDivElement;
let root: Root;
let paneWidth = 0;
let resized: (() => void)[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  paneWidth = 0;
  resized = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly onResize: () => void) {}
      observe() {
        resized.push(this.onResize);
      }
      disconnect() {
        resized = resized.filter((entry) => entry !== this.onResize);
      }
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function tasks(...statuses: TaskListItemStatus[]): Block {
  return {
    id: "tasks",
    role: "tasks",
    text: "",
    taskList: {
      key: "list",
      items: statuses.map((status, index) => ({
        id: String(index + 1),
        text: `Step ${index + 1}`,
        status,
      })),
    },
  };
}

function session(blocks: Block[], patch: Partial<Session> = {}): Session {
  return { ...newSession("claude", "/home/tony/app"), blocks, ...patch };
}

function section(name: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(
    `section[data-panel-section="${name}"]`,
  );
  if (!found) throw new Error(`No section named ${name}`);
  return found;
}

/** The step list under the panel's own "Progress" heading. */
function progress(): HTMLElement {
  const found = container.querySelector<HTMLElement>("[data-progress-steps]");
  if (!found) throw new Error("No step list");
  return found;
}

function usedRow(id: string): HTMLButtonElement | null {
  return container.querySelector(`button[data-used-row="${id}"]`);
}

/** The list a row opens. It is portalled out of the panel. */
function usedList(): HTMLElement | null {
  return document.body.querySelector("[data-used-list]");
}

type ViewProps = Parameters<typeof SessionPanelView>[0];

function view(props: Partial<ViewProps> & Pick<ViewProps, "session">) {
  act(() =>
    root.render(
      createElement(SessionPanelView, {
        outputs: [],
        onClose: vi.fn(),
        onOpenFile: vi.fn(),
        onShowInChat: vi.fn(),
        ...props,
      }),
    ),
  );
}

function tool(id: string, kind: string, title: string): Block {
  return {
    id,
    role: "tool",
    text: title,
    tool: { callId: id, kind, title, status: "completed" },
  };
}

function document_(path: string): DocumentFile {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return {
    path,
    name,
    relativePath: name,
    extension: "md",
    typeLabel: "Document · MD",
  };
}

function button(name: string): HTMLButtonElement | null {
  return container.querySelector(`button[aria-label="${name}"]`);
}

describe("SessionPanelView", () => {
  it("says so when the session has no task list and has written nothing", () => {
    view({
      session: session([
        { id: "u", role: "user", text: "What does this repo do?" },
        { id: "a", role: "assistant", text: "It is a desktop app." },
      ]),
    });
    expect(progress().textContent).toContain("No task list yet");
    expect(progress().querySelector("ol")).toBeNull();
    expect(container.querySelector("[data-progress-count]")).toBeNull();
    expect(container.querySelector("[data-progress-show]")).toBeNull();
    expect(section("Outputs").textContent).toContain("Nothing yet");
    // The folder the session works in is always something it uses.
    expect(usedRow("folders")?.textContent).toContain("~/app");
    expect(usedRow("commands")).toBeNull();
  });

  it("folds the finished steps into one row that opens on click", () => {
    view({
      session: session([
        tasks("completed", "completed", "in_progress", "pending"),
      ]),
    });
    expect(container.querySelector("[data-progress-count]")?.textContent).toBe(
      "2 of 4",
    );
    const fold = progress().querySelector<HTMLButtonElement>(
      "button[data-earlier-steps]",
    );
    expect(fold?.textContent).toBe("2 earlier steps");
    expect(fold?.getAttribute("aria-expanded")).toBe("false");
    expect(progress().textContent).not.toContain("Step 1");
    expect(progress().textContent).toContain("Step 3");

    act(() => fold?.click());
    expect(fold?.getAttribute("aria-expanded")).toBe("true");
    const rows = [...progress().querySelectorAll("ol > li")].map(
      (row) => row.textContent,
    );
    expect(rows).toEqual([
      "Hide earlier steps",
      "Completed: Step 1",
      "Completed: Step 2",
      "Step 3",
      "Step 4",
    ]);

    act(() => fold?.click());
    expect(fold?.textContent).toBe("2 earlier steps");
    expect(progress().textContent).not.toContain("Step 1");
  });

  it("uses the singular for one earlier step and shows a done list whole", () => {
    view({ session: session([tasks("completed", "pending")]) });
    const fold = progress().querySelector<HTMLButtonElement>(
      "[data-earlier-steps]",
    );
    expect(fold?.textContent).toBe("1 earlier step");
    act(() => fold?.click());
    expect(fold?.textContent).toBe("Hide earlier step");

    view({ session: session([tasks("completed", "completed")]) });
    expect(progress().querySelector("[data-earlier-steps]")).toBeNull();
    expect(
      container.querySelector("[data-progress-count]")?.textContent,
    ).toContain("Complete");
    expect(progress().querySelectorAll("ol > li")).toHaveLength(2);
  });

  it("jumps to the task list in the chat from the header", () => {
    const onShowInChat = vi.fn();
    view({
      session: session([
        { id: "u", role: "user", text: "Fix the build" },
        tasks("completed", "pending"),
      ]),
      onShowInChat,
    });
    act(() => button("Show the task list in chat")?.click());
    expect(onShowInChat).toHaveBeenCalledWith("tasks");
  });

  it("lists the documents the agent wrote and opens one on click", () => {
    const onOpenFile = vi.fn();
    view({
      session: session([]),
      outputs: [document_("/home/tony/app/notes.md")],
      onOpenFile,
    });
    const row = section("Outputs").querySelector<HTMLButtonElement>(
      "button[data-output]",
    );
    expect(row?.textContent).toBe("notes.mdMD");
    act(() => row?.click());
    expect(onOpenFile).toHaveBeenCalledWith("/home/tony/app/notes.md");
    expect(
      section("Outputs").querySelector("[data-output-reveal]"),
    ).not.toBeNull();
  });

  it("keeps a long list of documents behind a count until asked", () => {
    view({
      session: session([]),
      outputs: Array.from({ length: 9 }, (_, index) =>
        document_(`/home/tony/app/doc-${index}.md`),
      ),
    });
    const outputs = section("Outputs");
    expect(outputs.querySelectorAll("button[data-output]")).toHaveLength(6);
    const more = outputs.querySelector<HTMLButtonElement>(
      "button[data-output-more]",
    );
    expect(more?.textContent).toBe("+3 more");
    act(() => more?.click());
    expect(outputs.querySelectorAll("button[data-output]")).toHaveLength(9);
    expect(outputs.querySelector("[data-output-more]")).toBeNull();
  });

  it("names the first of each kind used and counts the rest", () => {
    view({
      session: session(
        [
          {
            id: "u",
            role: "user",
            text: "Look at these",
            attachments: [
              {
                id: "1",
                name: "a.png",
                mimeType: "image/png",
                kind: "image",
                size: 1,
              },
              {
                id: "2",
                name: "b.log",
                mimeType: "text/plain",
                kind: "file",
                size: 1,
                path: "/tmp/b.log",
              },
            ],
          },
          tool("1", "mcp__github__get_issue", "mcp__github__get_issue"),
          tool("2", "mcp__github__list_issues", "mcp__github__list_issues"),
          tool("3", "execute", "npm test"),
        ],
        { extraDirs: ["/home/tony/sdk"] },
      ),
    });
    const text = (id: string, part: string) =>
      usedRow(id)?.querySelector(`[data-used-${part}]`)?.textContent;
    expect(text("attachments", "preview")).toBe("a.png");
    expect(text("attachments", "more")).toBe("+1");
    expect(text("folders", "preview")).toBe("~/app");
    expect(text("folders", "more")).toBe("+1");
    expect(text("connectors", "preview")).toBe("github");
    expect(text("connectors", "more")).toBeUndefined();
    expect(text("commands", "preview")).toBe("npm test");
    expect(usedRow("web")).toBeNull();
    expect(usedRow("other")).toBeNull();
  });

  it("opens a row's list on click and acts on what is picked from it", () => {
    const onOpenFile = vi.fn();
    const onShowInChat = vi.fn();
    view({
      session: session([
        {
          id: "u",
          role: "user",
          text: "Look at these",
          attachments: [
            {
              id: "1",
              name: "a.png",
              mimeType: "image/png",
              kind: "image",
              size: 1,
            },
            {
              id: "2",
              name: "b.log",
              mimeType: "text/plain",
              kind: "file",
              size: 1,
              path: "/tmp/b.log",
            },
          ],
        },
        tool("3", "execute", "npm test"),
      ]),
      onOpenFile,
      onShowInChat,
    });
    expect(usedList()).toBeNull();
    act(() => usedRow("attachments")?.click());
    expect(usedRow("attachments")?.getAttribute("aria-expanded")).toBe("true");
    const entries = () => [
      ...(usedList()?.querySelectorAll<HTMLButtonElement>(
        "button[data-used-entry]",
      ) ?? []),
    ];
    expect(entries().map((entry) => entry.textContent)).toEqual([
      "a.png",
      "b.log",
    ]);
    // A pasted image has no file to open, so it leads back to its message,
    // and the list stays up for the next jump.
    act(() => entries()[0].click());
    expect(onShowInChat).toHaveBeenCalledWith("u");
    expect(usedList()).not.toBeNull();
    // Opening a file takes the viewer elsewhere, so the list goes.
    act(() => entries()[1].click());
    expect(onOpenFile).toHaveBeenCalledWith("/tmp/b.log");
    expect(usedList()).toBeNull();

    act(() => usedRow("commands")?.click());
    expect(usedList()?.getAttribute("data-used-list")).toBe("commands");
    act(() => entries()[0].click());
    expect(onShowInChat).toHaveBeenLastCalledWith("3");

    act(() => usedRow("commands")?.click());
    expect(usedList()).toBeNull();
  });

  it("shows a row's list while the pointer rests on it", () => {
    vi.useFakeTimers();
    view({ session: session([tool("3", "execute", "npm test")]) });
    const row = usedRow("commands")!;
    const over = (target: Element, type: "mouseover" | "mouseout") =>
      act(() => {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      });

    over(row, "mouseover");
    expect(usedList()).toBeNull();
    act(() => void vi.advanceTimersByTime(200));
    expect(usedList()).not.toBeNull();

    // Crossing from the row to its list keeps it open.
    over(row, "mouseout");
    over(usedList()!, "mouseover");
    act(() => void vi.advanceTimersByTime(400));
    expect(usedList()).not.toBeNull();

    over(usedList()!, "mouseout");
    act(() => void vi.advanceTimersByTime(400));
    expect(usedList()).toBeNull();
  });

  it("leaves Escape alone while a list is only being looked at", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    view({ session: session([tool("3", "execute", "npm test")]), onClose });
    const escape = () => {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      act(() => void document.body.dispatchEvent(event));
      return event;
    };

    act(() => {
      usedRow("commands")!.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true }),
      );
    });
    act(() => void vi.advanceTimersByTime(200));
    expect(usedList()?.hasAttribute("data-used-pinned")).toBe(false);
    // Typed somewhere else, Escape is still that place's to handle.
    expect(escape().defaultPrevented).toBe(false);
    expect(usedList()).not.toBeNull();

    // Clicked open, the list is the thing Escape closes, and only it.
    act(() => usedRow("commands")?.click());
    expect(usedList()?.hasAttribute("data-used-pinned")).toBe(true);
    expect(escape().defaultPrevented).toBe(true);
    expect(usedList()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(usedRow("commands"));
  });

  it("takes its list down when the pane goes behind another tab", () => {
    const quiet = session([tool("3", "execute", "npm test")]);
    view({ session: quiet });
    act(() => usedRow("commands")?.click());
    expect(usedList()).not.toBeNull();
    view({ session: quiet, visible: false });
    expect(usedList()).toBeNull();
  });

  it("drops an open list when its section is folded", () => {
    view({ session: session([tool("3", "execute", "npm test")]) });
    act(() => usedRow("commands")?.click());
    expect(usedList()).not.toBeNull();
    const fold = () =>
      section("Used in this session").querySelector<HTMLButtonElement>(
        "h4 button",
      );
    act(() => fold()?.click());
    expect(usedList()).toBeNull();
    act(() => fold()?.click());
    expect(usedList()).toBeNull();
    expect(usedRow("commands")).not.toBeNull();
  });

  it("folds its sections and remembers how they were left", () => {
    view({ session: session([tool("3", "execute", "npm test")]) });
    // What the session runs on rarely changes, so it starts folded.
    expect(section("Session").querySelector("dl")).toBeNull();
    act(() => section("Session").querySelector("button")?.click());
    expect(section("Session").textContent).toContain("Claude Code");
    expect(localStorage.getItem("monocode.sessionPanel.factsCollapsed")).toBe(
      "0",
    );

    const used = section("Used in this session");
    expect(usedRow("commands")).not.toBeNull();
    act(() => used.querySelector<HTMLButtonElement>("h4 button")?.click());
    expect(usedRow("commands")).toBeNull();
    expect(localStorage.getItem("monocode.sessionPanel.usedCollapsed")).toBe(
      "1",
    );
  });

  it("closes from its header and on Escape", () => {
    const onClose = vi.fn();
    view({ session: session([]), onClose });
    const close = button("Close session panel");
    expect(close?.getAttribute("aria-controls")).toBe(
      container.querySelector("aside")?.id,
    );
    act(() => close?.click());
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      container
        .querySelector("aside")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("is a column of its own, never laid over the transcript", () => {
    view({ session: session([]) });
    const aside = container.querySelector("aside");
    expect(aside?.hasAttribute("data-session-panel")).toBe(true);
    expect(aside?.className).not.toContain("absolute");
    expect(aside?.className).toContain("shrink-0");
    expect(aside?.style.width).toBe(`${SESSION_PANEL_WIDTH}px`);
  });

  it("folds the step list from its heading and remembers it", () => {
    const working = session([tasks("completed", "in_progress", "pending")]);
    view({ session: working });
    const fold = () =>
      container.querySelector<HTMLButtonElement>("[data-progress-fold]");
    expect(fold()?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("[data-progress-steps]")).not.toBeNull();

    act(() => fold()?.click());
    expect(fold()?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[data-progress-steps]")).toBeNull();
    // The count stays in the heading, so a folded list still says where it is.
    expect(container.querySelector("[data-progress-count]")?.textContent).toBe(
      "1 of 3",
    );
    expect(
      localStorage.getItem("monocode.sessionPanel.progressCollapsed"),
    ).toBe("1");
    expect(section("Outputs")).not.toBeNull();

    act(() => fold()?.click());
    expect(container.querySelector("[data-progress-steps]")).not.toBeNull();
  });
});

describe("the panel in a pane", () => {
  let control: SessionPanelControl;
  const started = session([{ id: "u", role: "user", text: "Fix the build" }]);

  function Pane({ eligible }: { eligible: boolean }) {
    control = useSessionPanel(eligible, started);
    return createElement(
      "div",
      {
        ref: (element: HTMLDivElement | null) => {
          if (element) {
            element.getBoundingClientRect = () =>
              ({ width: paneWidth }) as DOMRect;
          }
          control.paneRef(element);
        },
      },
      createElement(SessionPanelSlot),
      createElement(SessionPanelToggle, { panel: control, place: "title-bar" }),
      createElement(SessionPanel, {
        panel: control,
        session: started,
        onOpenFile: vi.fn(),
        onShowInChat: vi.fn(),
      }),
    );
  }

  function resize(width: number) {
    paneWidth = width;
    act(() => resized.forEach((notify) => notify()));
  }

  function render(eligible = true) {
    act(() => root.render(createElement(Pane, { eligible })));
  }

  function aside() {
    return container.querySelector("aside");
  }

  it("starts closed behind a button that opens and closes it", () => {
    paneWidth = 1200;
    render();
    expect(aside()).toBeNull();
    act(() => button("Show session panel")?.click());
    expect(aside()).not.toBeNull();
    expect(localStorage.getItem("monocode.sessionPanelOpen")).toBe("1");
    // The button stays, pressed, as the other way to close the panel.
    expect(button("Hide session panel")?.getAttribute("aria-expanded")).toBe(
      "true",
    );

    act(() => button("Hide session panel")?.click());
    expect(aside()).toBeNull();
    expect(localStorage.getItem("monocode.sessionPanelOpen")).toBe("0");

    act(() => button("Show session panel")?.click());
    act(() => button("Close session panel")?.click());
    expect(aside()).toBeNull();
    expect(button("Show session panel")).not.toBeNull();
    expect(localStorage.getItem("monocode.sessionPanelOpen")).toBe("0");
  });

  it("takes focus when opened here, so Escape closes it", () => {
    paneWidth = 1200;
    render();
    act(() => button("Show session panel")?.click());
    expect(aside()?.contains(document.activeElement)).toBe(true);
  });

  it("opens straight away when the viewer left it open, without taking focus", () => {
    localStorage.setItem("monocode.sessionPanelOpen", "1");
    paneWidth = 1200;
    render();
    expect(aside()).not.toBeNull();
    expect(aside()?.contains(document.activeElement)).toBe(false);
  });

  it("has neither panel nor button in a pane too narrow to push", () => {
    localStorage.setItem("monocode.sessionPanelOpen", "1");
    paneWidth = SESSION_PANEL_MIN_PANE_WIDTH - 1;
    render();
    // No room to push the transcript aside, and it is never covered instead.
    expect(aside()).toBeNull();
    expect(container.querySelector("button")).toBeNull();

    resize(SESSION_PANEL_MIN_PANE_WIDTH);
    expect(aside()).not.toBeNull();

    resize(500);
    expect(aside()).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    // The choice is kept for when there is room again.
    expect(localStorage.getItem("monocode.sessionPanelOpen")).toBe("1");
  });

  it("leaves the transcript a readable column at the narrowest", () => {
    expect(SESSION_PANEL_MIN_PANE_WIDTH - SESSION_PANEL_WIDTH).toBe(
      SESSION_PANEL_MIN_TRANSCRIPT_WIDTH,
    );
    expect(SESSION_PANEL_MIN_TRANSCRIPT_WIDTH).toBeGreaterThanOrEqual(360);
  });

  it("keeps its place while the pane is hidden", () => {
    localStorage.setItem("monocode.sessionPanelOpen", "1");
    paneWidth = 1200;
    render();
    resize(0);
    expect(aside()).not.toBeNull();
  });

  it("renders nothing for a session that does not get a panel", () => {
    localStorage.setItem("monocode.sessionPanelOpen", "1");
    paneWidth = 1200;
    render(false);
    expect(aside()).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });
});
