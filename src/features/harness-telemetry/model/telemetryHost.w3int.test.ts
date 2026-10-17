import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../../activity/model/activityTypes";
import {
  previewFromTool,
  toolKindFromName,
  toolTitle,
} from "../../../integrations/harness/providers/claude/claudeProtocol";
import { TelemetryFeed, fetchHost } from "./telemetryFeed";

// Wave 3 integration: lane B's request 4, a fetch call carries its host.

const opts = { joinWindowMs: 1000, maxHoldMs: 10_000, earlyMs: 500 };

describe("fetchHost", () => {
  it("reads the host of the first http(s) URL, for fetch kinds only", () => {
    expect(fetchHost("fetch", ["Fetch https://Docs.RS/serde"])).toBe("docs.rs");
    expect(fetchHost("WebFetch", [undefined, "http://example.com:8080/a"])).toBe(
      "example.com",
    );
    expect(fetchHost("execute", ["curl https://evil.test"])).toBeUndefined();
    expect(fetchHost(undefined, ["https://evil.test"])).toBeUndefined();
    expect(fetchHost("fetch", ["no url here", undefined])).toBeUndefined();
    expect(fetchHost("fetch", ["ftp://files.test/x"])).toBeUndefined();
  });

  it("never throws on junk", () => {
    expect(fetchHost("fetch", ["https://"])).toBeUndefined();
    expect(fetchHost("fetch", ["https://[::1"])).toBeUndefined();
    expect(fetchHost("fetch", ["x".repeat(100_000)])).toBeUndefined();
  });

  it("Claude Code's WebFetch adapter event names no URL, so its host comes from OTel", () => {
    // Recorded so a later adapter change that adds the URL is noticed.
    const input = { url: "https://example.com/page", prompt: "summarise" };
    const kind = toolKindFromName("WebFetch");
    const preview = previewFromTool("WebFetch", input);
    expect(
      fetchHost(kind, [
        toolTitle("WebFetch", input),
        preview?.query,
        preview?.path,
        preview?.title,
      ]),
    ).toBeUndefined();
  });
});

describe("the feed writes the host on a fetch call", () => {
  it("a fetch call's record carries detail.host and its callId", () => {
    const written: ActivityEvent[] = [];
    const f = new TelemetryFeed((e) => written.push(structuredClone(e)), opts);
    f.adapter(
      "c1",
      "claude",
      {
        type: "tool.started",
        callId: "w1",
        title: "Fetch https://api.example.com/v1",
        kind: "fetch",
      },
      0,
    );
    f.adapter("c1", "claude", { type: "tool.updated", callId: "w1", status: "completed" }, 10);
    f.tick(2000);
    expect(written).toHaveLength(1);
    expect(written[0].kind.startsWith("tool.")).toBe(true);
    expect(written[0].detail).toMatchObject({ callId: "w1", host: "api.example.com" });
  });

  it("a shell call naming a URL carries no host", () => {
    const written: ActivityEvent[] = [];
    const f = new TelemetryFeed((e) => written.push(structuredClone(e)), opts);
    f.adapter(
      "c1",
      "claude",
      {
        type: "tool.started",
        callId: "s1",
        title: "curl https://evil.test",
        kind: "execute",
        command: "curl https://evil.test",
        status: "completed",
      },
      0,
    );
    f.tick(2000);
    expect(written[0].detail.host).toBeUndefined();
  });
});

describe("the host from Claude Code's OTel tool_result", () => {
  function otelResult(at: number, input: unknown): ActivityEvent {
    return {
      id: `otel-${at}`,
      at,
      chatId: "c1",
      harness: "claude",
      source: "otel",
      kind: "tool.call",
      summary: "WebFetch",
      detail: {
        event: "tool_result",
        trust: "harness",
        attributes: { tool_use_id: "w1", tool_name: "WebFetch", tool_input: input },
      },
    };
  }

  it("a joined WebFetch call gets detail.otel.host from tool_input", () => {
    const written: ActivityEvent[] = [];
    const f = new TelemetryFeed((e) => written.push(structuredClone(e)), opts);
    f.adapter(
      "c1",
      "claude",
      { type: "tool.started", callId: "w1", title: "WebFetch", kind: "WebFetch" },
      0,
    );
    f.adapter("c1", "claude", { type: "tool.updated", callId: "w1", status: "completed" }, 10);
    f.otel(
      [otelResult(20, JSON.stringify({ url: "https://news.example.org/a", prompt: "p" }))],
      20,
    );
    f.tick(5000);
    expect(written).toHaveLength(1);
    expect(written[0].detail.callId).toBe("w1");
    // Kept under the OTel detail, never in the adapter's own fields (S4).
    expect(written[0].detail.host).toBeUndefined();
    expect((written[0].detail.otel as Record<string, unknown>).host).toBe("news.example.org");
  });

  it("an object tool_input works too, and a non-fetch tool gets none", () => {
    const written: ActivityEvent[] = [];
    const f = new TelemetryFeed((e) => written.push(structuredClone(e)), opts);
    f.otel([otelResult(5, { url: "https://obj.example.net/" })], 5);
    const bash = otelResult(6, JSON.stringify({ command: "curl https://evil.test" }));
    (bash.detail.attributes as Record<string, unknown>).tool_name = "Bash";
    (bash.detail.attributes as Record<string, unknown>).tool_use_id = "b1";
    f.otel([bash], 6);
    f.tick(5000);
    const hosts = written.map((e) => e.detail.host);
    expect(hosts).toContain("obj.example.net");
    expect(hosts.filter(Boolean)).toHaveLength(1);
  });
});

describe("adapter event ids", () => {
  function oneCall(f: TelemetryFeed, at: number) {
    f.adapter(
      "c1",
      "claude",
      { type: "tool.started", callId: `t${at}`, title: "ls", kind: "execute", status: "completed" },
      at,
    );
    f.tick(at + 2000);
  }

  it("never repeat across two runs of the app (security review S3)", () => {
    const first: ActivityEvent[] = [];
    oneCall(new TelemetryFeed((e) => first.push(e), opts), 0);
    const second: ActivityEvent[] = [];
    oneCall(new TelemetryFeed((e) => second.push(e), opts), 0);
    expect(first[0].id).not.toBe(second[0].id);
  });

  it("never repeat after a chat's state was dropped as idle", () => {
    const written: ActivityEvent[] = [];
    const f = new TelemetryFeed((e) => written.push(e), opts);
    oneCall(f, 0);
    f.tick(60 * 60 * 1000);
    oneCall(f, 60 * 60 * 1000 + 1);
    expect(written).toHaveLength(2);
    expect(written[0].id).not.toBe(written[1].id);
  });
});
