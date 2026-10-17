import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "../../../integrations/harness/core/types";
import { ApprovalsRecorder, cardSubject } from "./approvalsRecord";
import type { ApprovalRecord } from "./activityTypes";

type Requested = Extract<HarnessEvent, { type: "approval.requested" }>;

function recorder() {
  const written: ApprovalRecord[] = [];
  let clock = 1_000;
  const rec = new ApprovalsRecorder(
    (record) => written.push(record),
    () => clock,
  );
  return {
    rec,
    written,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

function asked(requestId: number, extra: Partial<Requested> = {}): Requested {
  return {
    type: "approval.requested",
    requestId,
    title: "Run npm test",
    ...extra,
  };
}

describe("the approvals record (B1)", () => {
  it("records a card's answer once, with its subject and the chat's harness", () => {
    const { rec, written } = recorder();
    rec.noteSession({ id: "c1", harness: "claude" });
    rec.noteHarnessEvent("c1", asked(7, { kind: "command" }));
    rec.noteHarnessEvent("c1", {
      type: "approval.resolved",
      requestId: 7,
      decision: "allow",
    });
    expect(written).toEqual([
      expect.objectContaining({
        chatId: "c1",
        harness: "claude",
        subject: "command",
        target: "Run npm test",
        scope: "once",
        granted: true,
      }),
    ]);
    // The same resolution again (a replay) finds nothing pending.
    rec.noteHarnessEvent("c1", {
      type: "approval.resolved",
      requestId: 7,
      decision: "allow",
    });
    expect(written).toHaveLength(1);
  });

  it("records a denial as not granted, and a hook's cancel as nothing", () => {
    const { rec, written } = recorder();
    rec.noteHarnessEvent("c1", asked(1));
    rec.noteHarnessEvent("c1", {
      type: "approval.resolved",
      requestId: 1,
      decision: "deny",
    });
    rec.noteHarnessEvent("c1", asked(2));
    rec.noteHarnessEvent("c1", {
      type: "approval.resolved",
      requestId: 2,
      decision: "cancelled",
    });
    expect(written).toHaveLength(1);
    expect(written[0].granted).toBe(false);
  });

  it("keeps requests of different chats apart", () => {
    const { rec, written } = recorder();
    rec.noteHarnessEvent("c1", asked(1, { title: "one" }));
    rec.noteHarnessEvent("c2", asked(1, { title: "two" }));
    rec.noteHarnessEvent("c2", {
      type: "approval.resolved",
      requestId: 1,
      decision: "allow",
    });
    expect(written[0]).toMatchObject({ chatId: "c2", target: "two" });
  });

  it("names what a card is about", () => {
    expect(
      cardSubject(
        asked(1, {
          network: { host: "registry.npmjs.org", protocol: "https" },
        }),
      ),
    ).toMatchObject({ subject: "host", target: "registry.npmjs.org" });
    expect(
      cardSubject(
        asked(1, {
          site: {
            server: "b",
            host: "example.com",
            chatKey: "c1",
            projectKey: "/p",
          },
        }),
      ),
    ).toMatchObject({ subject: "host", target: "example.com" });
    expect(
      cardSubject(
        asked(1, { tool: { key: "Bash(npm test *)", label: "npm test" } }),
      ),
    ).toEqual({
      subject: "command",
      target: "npm test commands",
    });
    expect(
      cardSubject(asked(1, { tool: { key: "WebFetch", label: "Fetch" } })),
    ).toEqual({
      subject: "tool",
      target: "WebFetch",
    });
  });

  it("keeps harness text plain and short", () => {
    const title = `line one\nline two\u0007 ${"x".repeat(2_000)}`;
    const subject = cardSubject(asked(1, { title }));
    expect(subject.target).not.toMatch(/[\n\u0007]/);
    expect(subject.target.length).toBeLessThanOrEqual(1_024);
  });

  it("does not record rules that were there when the app started", () => {
    const { rec, written } = recorder();
    rec.noteSession({
      id: "c1",
      harness: "codex",
      toolAccess: { "codex:command": "always" },
    });
    expect(written).toEqual([]);
  });

  it("records a new rule, and its end when it is removed or changed", () => {
    const { rec, written, tick } = recorder();
    rec.noteSession({ id: "c1", harness: "claude", toolAccess: {} });
    tick(10);
    rec.noteSession({
      id: "c1",
      harness: "claude",
      toolAccess: { "Bash(npm test *)": "always" },
    });
    expect(written).toEqual([
      expect.objectContaining({
        subject: "command",
        target: "npm test commands",
        scope: "chat",
        granted: true,
        grantedAt: 1_010,
      }),
    ]);
    expect(written[0].endedAt).toBeUndefined();
    tick(10);
    rec.noteSession({
      id: "c1",
      harness: "claude",
      toolAccess: { "Bash(npm test *)": "always" },
    });
    expect(written).toHaveLength(1);
    tick(10);
    rec.noteSession({
      id: "c1",
      harness: "claude",
      toolAccess: { WebFetch: "never" },
    });
    expect(written).toHaveLength(3);
    expect(written[1]).toMatchObject({ id: written[0].id, endedAt: 1_030 });
    expect(written[2]).toMatchObject({
      subject: "tool",
      target: "WebFetch",
      granted: false,
    });
  });

  it("does not end a rule it never saw begin", () => {
    const { rec, written } = recorder();
    rec.noteSession({
      id: "c1",
      harness: "claude",
      toolAccess: { WebFetch: "always" },
    });
    rec.noteSession({ id: "c1", harness: "claude", toolAccess: {} });
    expect(written).toEqual([]);
  });

  it("records Always allow for a network host as a standing host approval", () => {
    const { rec, written } = recorder();
    rec.noteHarnessEvent(
      "c1",
      asked(3, { network: { host: "pypi.org", protocol: "https" } }),
    );
    rec.noteChoice("c1", 3, "allow", {
      networkAmendment: { host: "pypi.org", action: "allow" },
    });
    rec.noteChoice("c1", 4, "deny", {
      networkAmendment: { host: "evil.test", action: "allow" },
    });
    rec.noteChoice("c1", 5, "allow");
    expect(written).toEqual([
      expect.objectContaining({
        subject: "host",
        target: "pypi.org",
        scope: "always",
        granted: true,
      }),
    ]);
  });

  it("records site rules made after start, a project's with no chat", () => {
    const { rec, written, tick } = recorder();
    rec.noteSiteRules({ chat: { c1: { "old.dev": "always" } }, project: {} });
    expect(written).toEqual([]);
    tick(5);
    rec.noteSiteRules({
      chat: { c1: { "old.dev": "always", "new.dev": "always" } },
      project: { "/Users/t/app": { "docs.rs": "always" } },
    });
    expect(written).toEqual([
      expect.objectContaining({
        chatId: "c1",
        target: "new.dev",
        scope: "chat",
      }),
      expect.objectContaining({
        chatId: "",
        target: "docs.rs",
        scope: "always",
      }),
    ]);
    tick(5);
    rec.noteSiteRules({ chat: { c1: { "old.dev": "always" } }, project: {} });
    expect(written.slice(2).map((r) => r.endedAt)).toEqual([1_010, 1_010]);
  });

  it("bounds what it holds pending", () => {
    const { rec, written } = recorder();
    for (let i = 0; i < 600; i++) rec.noteHarnessEvent("c1", asked(i));
    rec.noteHarnessEvent("c1", {
      type: "approval.resolved",
      requestId: 0,
      decision: "allow",
    });
    rec.noteHarnessEvent("c1", {
      type: "approval.resolved",
      requestId: 599,
      decision: "allow",
    });
    expect(written).toHaveLength(1);
  });

  it("forgets a closed chat", () => {
    const { rec, written } = recorder();
    rec.noteSession({ id: "c1", harness: "claude" });
    rec.noteHarnessEvent("c1", asked(1));
    rec.forgetSession("c1");
    expect(rec.harnessOf("c1")).toBe("");
    rec.noteHarnessEvent("c1", {
      type: "approval.resolved",
      requestId: 1,
      decision: "allow",
    });
    expect(written).toEqual([]);
  });
});
