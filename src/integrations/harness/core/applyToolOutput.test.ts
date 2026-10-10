import { describe, expect, it } from "vitest";
import {
  newSession,
  type Session,
} from "../../../features/sessions/model/session";
import { mapCodexNotification } from "../providers/codex/codexProtocol";
import { applyHarnessEvent } from "./apply";
import type { HarnessEvent } from "./types";

function started(): Session {
  return applyHarnessEvent(newSession("codex", "/repo"), {
    type: "tool.started",
    callId: "cmd",
    title: "npm test",
    kind: "execute",
    status: "in_progress",
  });
}

function piece(detail: string): HarnessEvent {
  return {
    type: "tool.updated",
    callId: "cmd",
    kind: "execute",
    status: "in_progress",
    detail,
    append: true,
  };
}

function detailOf(session: Session): string | undefined {
  return session.blocks.find((block) => block.tool?.callId === "cmd")?.tool
    ?.detail;
}

describe("a running call's output", () => {
  it("adds each piece to what the call has printed so far", () => {
    let session = started();
    session = applyHarnessEvent(session, piece("RUN v3\n"));
    session = applyHarnessEvent(session, piece(" ✓ a.test.ts\n"));
    session = applyHarnessEvent(session, piece(" ✓ b.test.ts\n"));
    expect(detailOf(session)).toBe("RUN v3\n ✓ a.test.ts\n ✓ b.test.ts\n");
  });

  it("keeps the latest lines of a log that outgrows the limit", () => {
    let session = started();
    session = applyHarnessEvent(session, piece("first line\n"));
    session = applyHarnessEvent(session, piece("x".repeat(9_000)));
    session = applyHarnessEvent(session, piece("\nlast line"));
    const detail = detailOf(session) ?? "";
    expect(detail.startsWith("…\n")).toBe(true);
    expect(detail.endsWith("last line")).toBe(true);
    expect(detail).not.toContain("first line");
    expect(detail.length).toBeLessThanOrEqual(8_002);
  });

  it("gives way to the whole output when the call lands", () => {
    let session = started();
    session = applyHarnessEvent(session, piece("RUN v3\n"));
    session = applyHarnessEvent(session, {
      type: "tool.updated",
      callId: "cmd",
      kind: "execute",
      status: "completed",
      detail: "RUN v3\n ✓ a.test.ts\n1 passed",
    });
    expect(detailOf(session)).toBe("RUN v3\n ✓ a.test.ts\n1 passed");
  });

  it("still replaces the detail when an update is not a piece", () => {
    let session = started();
    session = applyHarnessEvent(session, {
      type: "tool.updated",
      callId: "cmd",
      status: "pending",
      detail: "Bash: npm test",
    });
    session = applyHarnessEvent(session, {
      type: "tool.updated",
      callId: "cmd",
      status: "completed",
      detail: "1 passed",
    });
    expect(detailOf(session)).toBe("1 passed");
  });

  it("ignores an empty piece", () => {
    let session = started();
    session = applyHarnessEvent(session, piece("RUN v3\n"));
    const before = session;
    session = applyHarnessEvent(session, piece(""));
    expect(detailOf(session)).toBe("RUN v3\n");
    expect(session).toBe(before);
  });
});

describe("Codex command output", () => {
  it("arrives as pieces to add, not as the output", () => {
    const { events } = mapCodexNotification(
      "item/commandExecution/outputDelta",
      { itemId: "cmd", delta: " ✓ a.test.ts\n" },
    );
    expect(events).toEqual([
      {
        type: "tool.updated",
        callId: "cmd",
        kind: "execute",
        detail: " ✓ a.test.ts\n",
        append: true,
        status: "in_progress",
      },
    ]);
  });

  it("adds up across deltas in a session", () => {
    let session = started();
    for (const delta of ["RUN v3\n", " ✓ a.test.ts\n"]) {
      const { events } = mapCodexNotification(
        "item/commandExecution/outputDelta",
        { itemId: "cmd", delta },
      );
      for (const event of events) session = applyHarnessEvent(session, event);
    }
    expect(detailOf(session)).toBe("RUN v3\n ✓ a.test.ts\n");
  });
});
