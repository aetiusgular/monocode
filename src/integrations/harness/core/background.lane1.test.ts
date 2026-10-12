import { describe, expect, it } from "vitest";
import {
  backgroundItemsKey,
  MAX_BACKGROUND_ITEMS,
  sanitizeBackgroundItem,
  sanitizeBackgroundItems,
  sortBackgroundItems,
  type BackgroundItem,
} from "./background";
import { applyHarnessEvent, stopStreaming } from "./apply";
import { newSession, type Block } from "../../../features/sessions/model/session";

const item = (patch: Partial<BackgroundItem> = {}): BackgroundItem => ({
  id: "t1",
  kind: "shell",
  title: "npm test",
  status: "running",
  stoppable: true,
  source: "harness",
  ...patch,
});

describe("sanitizeBackgroundItem", () => {
  it("keeps a well-formed item", () => {
    expect(sanitizeBackgroundItem(item({ startedAt: 5 }))).toEqual(
      item({ startedAt: 5 }),
    );
  });

  it("drops what has no id and fills safe defaults", () => {
    expect(sanitizeBackgroundItem(null)).toBeNull();
    expect(sanitizeBackgroundItem({ title: "x" })).toBeNull();
    expect(sanitizeBackgroundItem({ id: "  " })).toBeNull();
    expect(
      sanitizeBackgroundItem({ id: "a", kind: "rootkit", status: "odd" }),
    ).toEqual({
      id: "a",
      kind: "shell",
      title: "Background task",
      status: "running",
      stoppable: false,
      source: "harness",
    });
  });

  it("strips control characters so a title cannot hide text", () => {
    const clean = sanitizeBackgroundItem({
      id: "a",
      title: "ok\u001b[2Jhidden\r\nmore",
    });
    expect(clean?.title).toBe("ok [2Jhidden more");
  });

  it("bounds the title and refuses bad start times", () => {
    const clean = sanitizeBackgroundItem({
      id: "a",
      title: "x".repeat(1000),
      startedAt: Number.NaN,
    });
    expect(clean?.title).toHaveLength(300);
    expect(clean?.startedAt).toBeUndefined();
    expect(sanitizeBackgroundItem({ id: "a", startedAt: -1 })?.startedAt)
      .toBeUndefined();
  });

  it("treats only an explicit true as stoppable", () => {
    expect(sanitizeBackgroundItem({ id: "a", stoppable: "yes" })?.stoppable)
      .toBe(false);
  });
});

describe("sanitizeBackgroundItems", () => {
  it("drops duplicates per source and caps the list", () => {
    const many = Array.from({ length: MAX_BACKGROUND_ITEMS + 20 }, (_, i) =>
      item({ id: `t${i}` }),
    );
    expect(sanitizeBackgroundItems(many)).toHaveLength(MAX_BACKGROUND_ITEMS);
    expect(
      sanitizeBackgroundItems([
        item(),
        item(),
        item({ source: "monocode" }),
      ]),
    ).toHaveLength(2);
    expect(sanitizeBackgroundItems("nope")).toEqual([]);
  });
});

describe("sortBackgroundItems and backgroundItemsKey", () => {
  it("puts running work first, then the newest", () => {
    const sorted = sortBackgroundItems([
      item({ id: "done", status: "done", startedAt: 30 }),
      item({ id: "old", startedAt: 10 }),
      item({ id: "new", startedAt: 20 }),
      item({ id: "stopping", status: "stopping", startedAt: 40 }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual([
      "new",
      "old",
      "stopping",
      "done",
    ]);
  });

  it("changes with any field the UI shows", () => {
    const base = backgroundItemsKey([item()]);
    expect(backgroundItemsKey([item()])).toBe(base);
    expect(backgroundItemsKey([item({ status: "stopping" })])).not.toBe(base);
    expect(backgroundItemsKey([item({ title: "npm run" })])).not.toBe(base);
    expect(backgroundItemsKey([])).toBe("");
  });
});

describe("background.items and turn.checkpoint events", () => {
  it("sets and clears the session's Running items", () => {
    const start = newSession("claude", "/repo");
    const withItems = applyHarnessEvent(start, {
      type: "background.items",
      items: [item()],
    });
    expect(withItems.backgroundItems).toEqual([item()]);
    const cleared = applyHarnessEvent(withItems, {
      type: "background.items",
      items: [],
    });
    expect("backgroundItems" in cleared).toBe(false);
    // Nothing to clear leaves the session object as it was.
    expect(applyHarnessEvent(start, { type: "background.items", items: [] }))
      .toBe(start);
  });

  it("drops the items when the turn stops streaming", () => {
    const session = applyHarnessEvent(newSession("codex", "/repo"), {
      type: "background.items",
      items: [item()],
    });
    expect(stopStreaming(session).backgroundItems).toBeUndefined();
  });

  it("tags the turn's own user message with its checkpoint id", () => {
    const blocks: Block[] = [
      { id: "u1", role: "user", text: "first", checkpointTurnId: "cp-1" },
      { id: "a1", role: "assistant", text: "ok" },
      { id: "u2", role: "user", text: "second" },
      { id: "u3", role: "user", text: "queued" },
    ];
    const session = {
      ...newSession("claude", "/repo"),
      blocks,
      queuedMessages: [
        { id: "q1", blockId: "u3", text: "queued", attachments: [] },
      ],
    };
    const next = applyHarnessEvent(session, {
      type: "turn.checkpoint",
      checkpointTurnId: "cp-2",
    });
    expect(next.blocks.map((block) => block.checkpointTurnId)).toEqual([
      "cp-1",
      undefined,
      "cp-2",
      undefined,
    ]);
  });

  it("never moves an id a message already has", () => {
    const session = {
      ...newSession("claude", "/repo"),
      blocks: [
        { id: "u1", role: "user", text: "first", checkpointTurnId: "cp-1" },
      ] as Block[],
    };
    expect(
      applyHarnessEvent(session, {
        type: "turn.checkpoint",
        checkpointTurnId: "cp-9",
      }),
    ).toBe(session);
    const empty = newSession("claude", "/repo");
    expect(
      applyHarnessEvent(empty, {
        type: "turn.checkpoint",
        checkpointTurnId: "cp-9",
      }),
    ).toBe(empty);
  });
});
