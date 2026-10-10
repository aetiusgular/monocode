// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Block } from "../../sessions/model/session";
import { AgentTranscript } from "../../sessions/ui/AgentTranscript";

const probes = vi.hoisted(() => ({
  stat: vi.fn(),
  reveal: vi.fn(),
}));
vi.mock("../../../platform/tauri/fs", async (original) => ({
  ...(await original<typeof import("../../../platform/tauri/fs")>()),
  statFiles: probes.stat,
  revealPath: probes.reveal,
}));

const CWD = "/Users/ada/project";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  probes.stat.mockReset();
  probes.reveal.mockReset();
  // Every file is on disk unless a test says otherwise.
  probes.stat.mockImplementation(async (paths: string[]) =>
    paths.map((path) => ({ path, mtimeMs: 1 })),
  );
  probes.reveal.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function write(relative: string, status = "completed"): Block {
  return {
    id: `write-${relative}`,
    role: "tool",
    text: "Write",
    tool: {
      kind: "edit",
      title: "Write",
      status,
      preview: {
        kind: "write",
        path: `${CWD}/${relative}`,
        fileName: relative.split("/").pop(),
        contentOnly: true,
      },
    },
  };
}

const TWO_TURNS: Block[] = [
  { id: "first", role: "user", text: "Write the plan", durationMs: 1000 },
  write("docs/plan.md"),
  write("src/plan.ts"),
  { id: "first-answer", role: "assistant", text: "The plan is written." },
  { id: "second", role: "user", text: "Thanks", durationMs: 1000 },
  { id: "second-answer", role: "assistant", text: "You're welcome." },
];

async function render(
  blocks: Block[],
  props: Partial<ComponentProps<typeof AgentTranscript>> = {},
) {
  await act(async () =>
    root.render(
      createElement(AgentTranscript, {
        blocks,
        cwd: CWD,
        documentCards: true,
        onOpenFile: () => {},
        ...props,
      }),
    ),
  );
}

function cards(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-file-card]")];
}

function button(name: string): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(
    `button[aria-label="${name}"]`,
  )!;
}

it("cards a regular session's documents under the turn that wrote them", async () => {
  const onOpenFile = vi.fn();
  await render(TWO_TURNS, { onOpenFile });

  expect(cards()).toHaveLength(1);
  const card = cards()[0];
  expect(card.getAttribute("data-file-card")).toBe(`${CWD}/docs/plan.md`);
  expect(card.textContent).toContain("plan.md");
  expect(card.textContent).toContain("Document · MD");
  expect(card.textContent).toContain("docs/plan.md");
  const turn = card.closest("[data-transcript-turn]")!;
  expect(turn.getAttribute("data-transcript-turn")).toBe("first");
  // After the reply, with the turn's other results.
  const reply = [...turn.querySelectorAll(".agent-markdown")].find((node) =>
    node.textContent?.includes("The plan is written."),
  )!;
  expect(
    reply.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  act(() => button("Open plan.md").click());
  expect(onOpenFile).toHaveBeenCalledWith(`${CWD}/docs/plan.md`);
  const reveal = card.querySelector<HTMLButtonElement>(
    'button[aria-label$=": plan.md"]',
  )!;
  await act(async () => reveal.click());
  expect(probes.reveal).toHaveBeenCalledWith(`${CWD}/docs/plan.md`);
  expect(card.querySelector('[role="status"]')).toBeNull();
});

it("renders no cards unless the transcript opts in", async () => {
  // Mono chats, orchestration workers, side threads and remote sessions leave
  // the flag off; so does a transcript that cannot open files.
  await render(TWO_TURNS, { documentCards: undefined });
  expect(cards()).toHaveLength(0);
  await render(TWO_TURNS, { documentCards: true, onOpenFile: undefined });
  expect(cards()).toHaveLength(0);
  await render(TWO_TURNS, { documentCards: false, inlineWork: true });
  expect(cards()).toHaveLength(0);
  await render(TWO_TURNS, { documentCards: false, managed: true });
  expect(cards()).toHaveLength(0);
  expect(probes.stat).not.toHaveBeenCalled();
});

it("shows a live turn's completed writes and adds the rest as they land", async () => {
  const live = (pending: string): Block[] => [
    { id: "prompt", role: "user", text: "Write two notes" },
    write("notes/done.md"),
    write("notes/pending.md", pending),
  ];
  await render(live("in_progress"), { busy: true });
  expect(cards().map((card) => card.textContent)).toEqual([
    expect.stringContaining("done.md"),
  ]);
  await render(live("failed"), { busy: true });
  expect(cards()).toHaveLength(1);
  await render(live("completed"), { busy: true });
  expect(cards()).toHaveLength(2);
});

it("withdraws the card of a file that is no longer on disk", async () => {
  probes.stat.mockImplementation(async (paths: string[]) =>
    paths.map((path) => ({
      path,
      mtimeMs: path.endsWith("deleted.md") ? null : 1,
    })),
  );
  await render([
    { id: "prompt", role: "user", text: "Tidy the docs", durationMs: 1000 },
    write("docs/kept.md"),
    write("docs/deleted.md"),
    { id: "answer", role: "assistant", text: "Done." },
  ]);
  expect(probes.stat).toHaveBeenCalledWith([
    `${CWD}/docs/kept.md`,
    `${CWD}/docs/deleted.md`,
  ]);
  expect(cards().map((card) => card.getAttribute("data-file-card"))).toEqual([
    `${CWD}/docs/kept.md`,
  ]);
});

it("keeps every card when the disk check itself fails", async () => {
  probes.stat.mockRejectedValue(new Error("no backend"));
  await render(TWO_TURNS);
  expect(cards()).toHaveLength(1);
});

it("says so when a file cannot be revealed", async () => {
  probes.reveal.mockRejectedValue(new Error("No such file or directory"));
  await render(TWO_TURNS);
  const reveal = cards()[0].querySelector<HTMLButtonElement>(
    'button[aria-label$=": plan.md"]',
  )!;
  await act(async () => reveal.click());
  expect(cards()[0].querySelector('[role="status"]')?.textContent).toBe(
    "Couldn’t reveal this file",
  );
});

it("folds cards past the cap behind a row that expands", async () => {
  await render([
    { id: "prompt", role: "user", text: "Write notes", durationMs: 1000 },
    ...Array.from({ length: 8 }, (_, index) =>
      write(`notes/note-${index + 1}.md`),
    ),
    { id: "answer", role: "assistant", text: "Eight notes." },
  ]);
  const more = container.querySelector<HTMLButtonElement>(
    "[data-file-cards-more]",
  )!;
  expect(cards()).toHaveLength(6);
  expect(more.textContent).toBe("+2 more");
  expect(more.getAttribute("aria-expanded")).toBe("false");
  act(() => more.click());
  expect(cards()).toHaveLength(8);
  expect(more.textContent).toBe("Show fewer");
  expect(more.getAttribute("aria-expanded")).toBe("true");
  act(() => more.click());
  expect(cards()).toHaveLength(6);
});
