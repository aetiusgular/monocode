import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../../activity/model/activityTypes";
import { TelemetryFeed, clipLine, otelToolKind } from "./telemetryFeed";

const opts = { joinWindowMs: 1000, maxHoldMs: 10_000, earlyMs: 500 };

function feed() {
  const written: ActivityEvent[] = [];
  const f = new TelemetryFeed((e) => written.push(structuredClone(e)), opts);
  return { f, written };
}

function otel(
  chatId: string,
  harness: string,
  kind: string,
  at: number,
  attributes: Record<string, unknown>,
  summary = "x",
): ActivityEvent {
  return {
    id: `otel-${Math.random()}`,
    at,
    chatId,
    harness: harness as ActivityEvent["harness"],
    source: "otel",
    kind,
    summary,
    detail: { event: kind, trust: "harness", attributes },
  };
}

describe("adapter events (A4)", () => {
  it("one tool call is written once, after its end and the join window", () => {
    const { f, written } = feed();
    f.adapter(
      "c1",
      "claude",
      {
        type: "tool.started",
        callId: "t1",
        title: "Run ls",
        kind: "execute",
        command: "ls",
      },
      0,
    );
    f.adapter(
      "c1",
      "claude",
      {
        type: "tool.updated",
        callId: "t1",
        status: "in_progress",
        detail: "a",
        append: true,
      },
      10,
    );
    f.adapter(
      "c1",
      "claude",
      { type: "tool.updated", callId: "t1", status: "completed" },
      100,
    );
    f.tick(500);
    expect(written).toHaveLength(0);
    f.tick(1100);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      chatId: "c1",
      harness: "claude",
      source: "adapter",
      kind: "tool.call",
      summary: "Run ls",
    });
    expect(written[0].detail).toMatchObject({
      callId: "t1",
      toolKind: "execute",
      status: "completed",
      command: "ls",
      endedAt: 100,
    });
    f.tick(5000);
    expect(written).toHaveLength(1);
  });

  it("turn start and end, session end and error", () => {
    const { f, written } = feed();
    f.adapter("c", "codex", { type: "turn.ready" }, 0);
    expect(written).toHaveLength(0);
    f.adapter("c", "codex", { type: "turn.started", providerTurnId: "p1" }, 1);
    f.adapter("c", "codex", { type: "turn.ready" }, 2);
    f.adapter("c", "codex", { type: "turn.ready" }, 3);
    f.adapter(
      "c",
      "codex",
      { type: "session.error", message: "boom\nline two" },
      4,
    );
    f.adapter("c", "codex", { type: "session.ended", code: 1 }, 5);
    expect(written.map((e) => e.kind)).toEqual([
      "turn.start",
      "turn.end",
      "session.error",
      "session.end",
    ]);
    expect(written[2].summary).toBe("boom line two");
    expect(written[3].summary).toBe("Harness stopped (exit 1)");
    expect(new Set(written.map((e) => e.id)).size).toBe(4);
  });

  it("session end writes what was held", () => {
    const { f, written } = feed();
    f.adapter(
      "c",
      "claude",
      { type: "tool.started", callId: "t", title: "Read a", kind: "read" },
      0,
    );
    f.adapter("c", "claude", { type: "session.ended" }, 1);
    expect(written.map((e) => e.kind)).toEqual(["tool.call", "session.end"]);
  });

  it("a call that never ends is written at the hold limit", () => {
    const { f, written } = feed();
    f.adapter(
      "c",
      "cursor",
      { type: "tool.started", callId: "t", title: "Long", kind: "execute" },
      0,
    );
    f.tick(9999);
    expect(written).toHaveLength(0);
    f.tick(10_000);
    expect(written).toHaveLength(1);
    expect(written[0].harness).toBe("cursor");
  });

  it("approvals record the decision", () => {
    const { f, written } = feed();
    f.adapter(
      "c",
      "codex",
      {
        type: "approval.requested",
        requestId: 7,
        title: "Run rm -rf build",
        kind: "execute",
        network: { host: "example.com", protocol: "https" },
      },
      0,
    );
    f.adapter(
      "c",
      "codex",
      { type: "approval.resolved", requestId: 7, decision: "deny" },
      50,
    );
    f.tick(2000);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      kind: "approval",
      summary: "Denied: Run rm -rf build",
    });
    expect(written[0].detail).toMatchObject({
      requestId: 7,
      decision: "deny",
      host: "example.com",
    });
  });

  it("events with no chat or of other types are ignored", () => {
    const { f, written } = feed();
    f.adapter("", "claude", { type: "turn.started", providerTurnId: "x" }, 0);
    f.adapter("c", "claude", { type: "message.delta", text: "hi" }, 0);
    f.tick(100_000);
    expect(written).toHaveLength(0);
  });
});

describe("the join (A5)", () => {
  it("Claude Code: an OTel tool result joins its call by tool_use_id and is written once", () => {
    const { f, written } = feed();
    f.adapter(
      "c",
      "claude",
      {
        type: "tool.started",
        callId: "toolu_1",
        title: "Run echo",
        kind: "execute",
      },
      0,
    );
    f.adapter(
      "c",
      "claude",
      { type: "tool.updated", callId: "toolu_1", status: "completed" },
      100,
    );
    f.otel(
      [
        otel(
          "c",
          "claude",
          "tool.call",
          120,
          {
            tool_name: "Bash",
            tool_use_id: "toolu_1",
            success: "true",
            duration_ms: "90",
          },
          "Bash ok, 90 ms",
        ),
      ],
      200,
    );
    // Joined and ended: written at once, no wait for the window.
    expect(written).toHaveLength(1);
    expect(written[0].source).toBe("adapter");
    expect(written[0].detail.otel).toMatchObject({
      trust: "harness",
      summary: "Bash ok, 90 ms",
      attributes: { tool_use_id: "toolu_1" },
    });
    f.tick(60_000);
    expect(written).toHaveLength(1);
  });

  it("Claude Code: an OTel event whose id matches no call is its own record, never a guess", () => {
    const { f, written } = feed();
    f.adapter(
      "c",
      "claude",
      {
        type: "tool.started",
        callId: "toolu_main",
        title: "Run ls",
        kind: "execute",
      },
      0,
    );
    // A subagent's Bash call: same kind, same time, other id.
    f.otel(
      [
        otel("c", "claude", "tool.call", 10, {
          tool_name: "Bash",
          tool_use_id: "toolu_sub",
        }),
      ],
      10,
    );
    expect(written).toHaveLength(1);
    expect(written[0].source).toBe("otel");
    f.adapter(
      "c",
      "claude",
      { type: "tool.updated", callId: "toolu_main", status: "completed" },
      20,
    );
    f.tick(2000);
    expect(written).toHaveLength(2);
    expect(written[1].detail.otel).toBeUndefined();
  });

  it("a running call joins an OTel event of its kind that arrives while it runs", () => {
    const { f, written } = feed();
    f.adapter(
      "c",
      "codex",
      { type: "tool.started", callId: "i", title: "edit", kind: "edit" },
      0,
    );
    f.otel(
      [otel("c", "codex", "tool.call", 5000, { tool_name: "apply_patch" })],
      5000,
    );
    expect(written).toHaveLength(0);
    f.adapter(
      "c",
      "codex",
      { type: "tool.updated", callId: "i", status: "completed" },
      5100,
    );
    expect(written).toHaveLength(1);
    expect(written[0].detail.otel).toBeDefined();
  });

  it("Codex: a call id miss falls back to the same kind within the window", () => {
    const { f, written } = feed();
    f.adapter(
      "c",
      "codex",
      {
        type: "tool.started",
        callId: "item_1",
        title: "echo hi",
        kind: "execute",
      },
      0,
    );
    f.adapter(
      "c",
      "codex",
      { type: "tool.updated", callId: "item_1", status: "completed" },
      50,
    );
    f.otel(
      [
        otel("c", "codex", "tool.call", 60, {
          tool_name: "exec_command",
          call_id: "call_x",
        }),
      ],
      70,
    );
    expect(written).toHaveLength(1);
    expect(written[0].detail.otel).toBeDefined();
  });

  it("Codex: another kind or a time outside the window does not join", () => {
    const { f, written } = feed();
    f.adapter(
      "c",
      "codex",
      { type: "tool.started", callId: "i", title: "edit", kind: "edit" },
      0,
    );
    f.otel(
      [otel("c", "codex", "tool.call", 10, { tool_name: "exec_command" })],
      10,
    );
    // Written unended at its hold limit (10 s); an edit result 40 s later is
    // not this call's.
    f.tick(10_000);
    f.otel(
      [otel("c", "codex", "tool.call", 50_000, { tool_name: "apply_patch" })],
      50_000,
    );
    expect(written.map((e) => e.source)).toEqual(["otel", "adapter", "otel"]);
    expect(written[1].detail.otel).toBeUndefined();
  });

  it("a late OTel event is written again under the adapter event's id", () => {
    const { f, written } = feed();
    f.adapter(
      "c",
      "claude",
      {
        type: "tool.started",
        callId: "toolu_2",
        title: "Edit a",
        kind: "edit",
      },
      0,
    );
    f.adapter(
      "c",
      "claude",
      { type: "tool.updated", callId: "toolu_2", status: "failed" },
      10,
    );
    f.tick(2000);
    expect(written).toHaveLength(1);
    f.otel(
      [
        otel("c", "claude", "tool.call", 15, {
          tool_name: "Edit",
          tool_use_id: "toolu_2",
          success: "false",
        }),
      ],
      3000,
    );
    expect(written).toHaveLength(2);
    expect(written[1].id).toBe(written[0].id);
    expect(written[1].detail.otel).toBeDefined();
  });

  it("an OTel decision joins the approval by call id", () => {
    const { f, written } = feed();
    f.adapter(
      "c",
      "claude",
      {
        type: "approval.requested",
        requestId: 1,
        title: "Bash: ls",
        kind: "execute",
        callId: "toolu_3",
      },
      0,
    );
    f.adapter(
      "c",
      "claude",
      { type: "approval.resolved", requestId: 1, decision: "allow" },
      5,
    );
    f.otel(
      [
        otel("c", "claude", "approval", 6, {
          tool_name: "Bash",
          tool_use_id: "toolu_3",
          decision: "accept",
          source: "user",
        }),
      ],
      6,
    );
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      kind: "approval",
      summary: "Allowed: Bash: ls",
    });
  });

  it("OTel events with no counterpart pass straight through", () => {
    const { f, written } = feed();
    f.otel(
      [
        otel("c", "claude", "model.request", 1, { model: "m" }),
        otel("c", "claude", "prompt", 2, {}),
      ],
      3,
    );
    expect(written.map((e) => e.kind)).toEqual(["model.request", "prompt"]);
  });

  it("malformed receiver events are dropped", () => {
    const { f, written } = feed();
    f.otel(
      [
        null as unknown as ActivityEvent,
        { ...otel("c", "claude", "x", 1, {}), source: "adapter" },
        { ...otel("", "claude", "x", 1, {}) },
      ],
      1,
    );
    expect(written).toHaveLength(0);
  });

  it("a chat's events never join another chat's calls", () => {
    const { f, written } = feed();
    f.adapter(
      "a",
      "codex",
      { type: "tool.started", callId: "i", title: "ls", kind: "execute" },
      0,
    );
    f.otel(
      [
        otel("b", "codex", "tool.call", 1, {
          tool_name: "exec_command",
          call_id: "i",
        }),
      ],
      1,
    );
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ chatId: "b", source: "otel" });
  });
});

describe("limits and failure", () => {
  it("a writer that throws never reaches the caller", () => {
    const f = new TelemetryFeed(() => {
      throw new Error("store down");
    }, opts);
    expect(() => {
      f.adapter(
        "c",
        "claude",
        { type: "turn.started", providerTurnId: "p" },
        0,
      );
      f.otel([otel("c", "claude", "prompt", 1, {})], 1);
      f.tick(1);
      f.flushAll();
    }).not.toThrow();
  });

  it("held calls are bounded per chat", () => {
    const { f, written } = feed();
    for (let i = 0; i < 520; i++) {
      f.adapter(
        "c",
        "claude",
        {
          type: "tool.started",
          callId: `t${i}`,
          title: `call ${i}`,
          kind: "read",
        },
        i,
      );
    }
    expect(f.heldCount()).toBe(500);
    expect(written).toHaveLength(20);
    expect(written[0].summary).toBe("call 0");
  });

  it("long titles and commands are clipped, control characters removed", () => {
    const { f, written } = feed();
    f.adapter(
      "c",
      "claude",
      {
        type: "tool.started",
        callId: "t",
        title: `a\u001b[31m${"x".repeat(500)}`,
        kind: "execute",
        command: "y".repeat(5000),
      },
      0,
    );
    f.flushAll();
    expect(written[0].summary.length).toBeLessThanOrEqual(201);
    expect(written[0].summary).not.toContain("\u001b");
    expect(String(written[0].detail.command).length).toBeLessThanOrEqual(2001);
  });

  it("a forgotten chat is pruned once nothing is held", () => {
    const { f } = feed();
    f.adapter(
      "c",
      "claude",
      { type: "tool.started", callId: "t", title: "x", kind: "read" },
      0,
    );
    f.tick(20_000);
    f.tick(20_000 + 11 * 60_000);
    expect(f.heldCount()).toBe(0);
  });
});

describe("helpers", () => {
  it("clipLine", () => {
    expect(clipLine("a\nb\tc")).toBe("a b c");
    expect(clipLine("abcdef", 3)).toBe("abc…");
  });

  it("otelToolKind maps both harnesses' names to adapter kinds", () => {
    expect(otelToolKind("claude", "Bash")).toBe("execute");
    expect(otelToolKind("claude", "Edit")).toBe("edit");
    expect(otelToolKind("claude", "Read")).toBe("read");
    expect(otelToolKind("codex", "exec_command")).toBe("execute");
    expect(otelToolKind("codex", "apply_patch")).toBe("edit");
    expect(otelToolKind("codex", "web_search")).toBe("search");
    expect(otelToolKind("codex", "mcp__x__y")).toBe("other");
  });
});
