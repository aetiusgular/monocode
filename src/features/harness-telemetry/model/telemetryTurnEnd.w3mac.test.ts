import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../../activity/model/activityTypes";
import { TelemetryFeed } from "./telemetryFeed";
import { TAPPED_EVENT_TYPES } from "./telemetryTap";

// Mac test 2.2: the feed wrote `turn.end` on `turn.ready`, which Claude's
// adapter sends right after the start and Codex's before it.

function feed() {
  const written: ActivityEvent[] = [];
  const f = new TelemetryFeed((e) => written.push(structuredClone(e)), {
    joinWindowMs: 1000,
    maxHoldMs: 10_000,
    earlyMs: 500,
  });
  return { f, written };
}

describe("a turn's end in the activity log", () => {
  it("is written from turn.completed, never from turn.ready", () => {
    const { f, written } = feed();
    f.adapter("c", "claude", { type: "turn.started", providerTurnId: "p" }, 1);
    f.adapter("c", "claude", { type: "turn.ready" }, 4);
    expect(written.map((e) => e.kind)).toEqual(["turn.start"]);
    f.adapter(
      "c",
      "claude",
      { type: "turn.completed", status: "interrupted" },
      9000,
    );
    expect(written.map((e) => e.kind)).toEqual(["turn.start", "turn.end"]);
    expect(written[1].at).toBe(9000);
    expect(written[1].detail).toEqual({ status: "interrupted" });
    expect(written[1].summary).toBe("Turn stopped");
  });

  it("a Codex turn whose ready came first still ends", () => {
    const { f, written } = feed();
    f.adapter("c", "codex", { type: "turn.ready" }, 1);
    f.adapter("c", "codex", { type: "turn.started", providerTurnId: "t" }, 2);
    f.adapter("c", "codex", { type: "turn.completed", status: "completed" }, 3);
    expect(written.map((e) => [e.kind, e.summary])).toEqual([
      ["turn.start", "Turn started"],
      ["turn.end", "Turn ended"],
    ]);
  });

  it("the tap reads turn.completed and skips turn.ready", () => {
    expect(TAPPED_EVENT_TYPES.has("turn.completed")).toBe(true);
    expect(TAPPED_EVENT_TYPES.has("turn.ready")).toBe(false);
  });
});

describe("the registry's turn end reaches the feed", () => {
  it("after the turn's start, through the tap", async () => {
    const {
      tapHarnessEvent,
      tapTurnCompleted,
      setChatHarnesses,
      telemetryFeed,
    } = await import("./telemetryTap");
    const seen: string[] = [];
    const original = telemetryFeed.adapter.bind(telemetryFeed);
    telemetryFeed.adapter = (chat, harness, event, now) => {
      seen.push(event.type);
      original(chat, harness, event, now);
    };
    setChatHarnesses([["c9", "codex"]]);
    tapTurnCompleted("c9", { type: "turn.completed", status: "completed" });
    tapTurnCompleted("c9", { type: "turn.ready" });
    void Promise.resolve().then(() =>
      tapHarnessEvent("c9", { type: "turn.started", providerTurnId: "t" }),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual(["turn.started", "turn.completed"]);
    telemetryFeed.adapter = original;
  });
});

describe("a repeated start", () => {
  it("for the same turn (a Codex steer) writes one start", () => {
    const { f, written } = feed();
    f.adapter("c", "codex", { type: "turn.started", providerTurnId: "t" }, 1);
    f.adapter("c", "codex", { type: "turn.started", providerTurnId: "t" }, 2);
    f.adapter("c", "codex", { type: "turn.completed", status: "completed" }, 3);
    f.adapter("c", "codex", { type: "turn.started", providerTurnId: "t" }, 4);
    expect(written.map((e) => e.kind)).toEqual([
      "turn.start",
      "turn.end",
      "turn.start",
    ]);
  });
});
