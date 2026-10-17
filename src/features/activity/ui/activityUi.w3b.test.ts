// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../../integrations/harness/core/types";
import { HarnessEventQueue } from "../../../app/model/harnessFlush";
import { EMPTY_REPORT, type FlagsReport } from "../model/activityPanel";
import { ACTIVITY_TAP_KEY, installActivityTap } from "../model/activityTap";
import {
  approvalPaneProps,
  chatContextOf,
  syncSessions,
  withApprovalNotes,
} from "./ActivityBridge";
import { ActivityFlagsView } from "./ActivitySection";
import { InstallPlanView } from "./ActivityLogPage";

const noop = () => undefined;

describe("the Activity section (B6)", () => {
  it("shows each flag as plain text, with the log's own notes first", () => {
    const report: FlagsReport = {
      ...EMPTY_REPORT,
      chainOk: false,
      flags: [
        {
          id: "writeOutsideFolders:es-1",
          chatId: "c1",
          at: 0,
          reason: "writeOutsideFolders",
          summary: "Deleted /Users/t/<img src=x onerror=alert(1)>.txt",
          eventId: "es-1",
          context: ["es-1"],
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(ActivityFlagsView, {
        report,
        sinceVisit: true,
        loading: false,
        onMarkSeen: noop,
        onShowWeek: noop,
        onRefresh: noop,
      }),
    );
    expect(html).toContain("does not verify");
    expect(html).toContain("Outside the chat&#x27;s folders");
    expect(html).toContain("&lt;img src=x");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("data-activity-seen");
  });

  it("says nothing was flagged, by the range it read", () => {
    const view = (sinceVisit: boolean) =>
      renderToStaticMarkup(
        createElement(ActivityFlagsView, {
          report: { ...EMPTY_REPORT, collectorReachable: true },
          sinceVisit,
          loading: false,
          onMarkSeen: noop,
          onShowWeek: noop,
          onRefresh: noop,
        }),
      );
    expect(view(true)).toContain("Nothing flagged since your last visit.");
    expect(view(false)).toContain("Nothing flagged in the last 7 days.");
    expect(view(true)).not.toContain("data-activity-seen");
  });
});

describe("the install plan (B4)", () => {
  it("shows the commands and the plist before anything runs, on a development build", () => {
    const html = renderToStaticMarkup(
      createElement(InstallPlanView, {
        plan: {
          route: "terminal",
          explanation: ["The collector runs as root."],
          plist: "<plist>",
          commands: ["sudo install a b", "sudo launchctl bootstrap system c"],
          stagedPlist: "/Users/t/stage.plist",
        },
        busy: false,
        onRegister: noop,
      }),
    );
    expect(html).toContain("runs as root");
    expect(html).toContain("sudo launchctl bootstrap system c");
    expect(html).toContain("&lt;plist&gt;");
    expect(html).not.toContain("data-activity-register");
  });

  it("offers the macOS registration only for a signed bundle", () => {
    const html = renderToStaticMarkup(
      createElement(InstallPlanView, {
        plan: {
          route: "smAppService",
          explanation: [],
          plist: "",
          commands: [],
        },
        busy: false,
        onRegister: noop,
      }),
    );
    expect(html).toContain("data-activity-register");
    expect(html).toContain("Login Items");
  });
});

describe("the activity bridge", () => {
  it("sends a chat's folders once, again on change, and forgets closed chats", () => {
    const sent = new Map<string, string>();
    const contexts: unknown[] = [];
    const forgot: string[] = [];
    const recorder = {
      noteSession: vi.fn(),
      forgetSession: (id: string) => forgot.push(id),
    };
    const session = {
      id: "c1",
      harness: "claude" as const,
      cwd: "/Users/t/app",
      extraDirs: ["/Users/t/lib", "/"],
    };
    syncSessions([session], sent, recorder, (c) => contexts.push(c));
    syncSessions([session], sent, recorder, (c) => contexts.push(c));
    expect(contexts).toEqual([
      {
        chatId: "c1",
        harness: "claude",
        folders: ["/Users/t/app", "/Users/t/lib"],
      },
    ]);
    syncSessions(
      [{ ...session, worktreeCwd: "/Users/t/wt" }],
      sent,
      recorder,
      (c) => contexts.push(c),
    );
    expect(contexts).toHaveLength(2);
    syncSessions([], sent, recorder, (c) => contexts.push(c));
    expect(forgot).toEqual(["c1"]);
  });

  it("reads the worktree as the working folder", () => {
    expect(
      chatContextOf({ id: "c", harness: "codex", cwd: "/a", worktreeCwd: "/b" })
        .folders,
    ).toEqual(["/b"]);
  });

  it("wraps the approval callback once, and always answers", () => {
    const answers: unknown[] = [];
    const onApproval = (...args: unknown[]) => answers.push(args);
    const first = withApprovalNotes(onApproval);
    expect(withApprovalNotes(onApproval)).toBe(first);
    expect(approvalPaneProps(onApproval).onApproval).toBe(first);
    first("c1", 1, "allow", {
      networkAmendment: { host: "a.dev", action: "allow" },
    });
    expect(answers).toHaveLength(1);
  });
});

describe("the event tap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[ACTIVITY_TAP_KEY];
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sees every live event once, through the app's own queue", () => {
    const seen: string[] = [];
    const remove = installActivityTap((id, event) =>
      seen.push(`${id}:${event.type}`),
    );
    const queue = new HarnessEventQueue(() => true, noop);
    const event: HarnessEvent = {
      type: "approval.resolved",
      requestId: 1,
      decision: "allow",
    };
    queue.enqueue("c1", event);
    expect(seen).toEqual(["c1:approval.resolved"]);
    remove();
    queue.enqueue("c1", event);
    expect(seen).toHaveLength(1);
  });

  it("a tap that throws never stops the stream (case 9)", () => {
    installActivityTap(() => {
      throw new Error("log broke");
    });
    const applied: number[] = [];
    const queue = new HarnessEventQueue(
      () => true,
      (batches) => applied.push(batches.size),
    );
    expect(() =>
      queue.enqueue("c1", {
        type: "approval.resolved",
        requestId: 1,
        decision: "allow",
      }),
    ).not.toThrow();
    expect(applied).toEqual([1]);
  });

  it("with no tap installed the queue runs as before", () => {
    const queue = new HarnessEventQueue(() => true, noop);
    expect(() =>
      queue.enqueue("c1", {
        type: "approval.resolved",
        requestId: 1,
        decision: "deny",
      }),
    ).not.toThrow();
  });
});
