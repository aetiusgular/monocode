import { describe, expect, it, vi } from "vitest";
import { buildDeepLink, OPERATOR_LINK_REASON, parseDeepLink } from "./deepLink";
import { noticeText, startDeepLinks, type DeepLinkDeps } from "./deepLinkController";
import { DeepLinkInbox } from "./deepLinkInbox";

// A deep link could carry /operator: it filled the composer, and sending it
// gave that chat app access. Agent-sent prompts already refuse it. Links now
// refuse it the same way, with the composer's own match.

describe("parseDeepLink and /operator", () => {
  it("refuses a prompt that starts with /operator, with a plain reason", () => {
    expect(parseDeepLink("monocode-harness://new?prompt=/operator%20list%20my%20sessions")).toEqual({
      ok: false,
      reason: OPERATOR_LINK_REASON,
    });
    expect(OPERATOR_LINK_REASON).toBe("A link cannot turn on app access. Type /operator yourself.");
  });

  it("refuses /operator in any case, alone, and the /mono and /monocode spellings", () => {
    for (const text of [
      "/OPERATOR list my sessions",
      "/Operator list my sessions",
      "/operator",
      "/operator\nlist my sessions",
      "/mono list my sessions",
      "/MONO",
      "/monocode list my sessions",
      "/MonoCode list my sessions",
    ]) {
      expect(parseDeepLink(buildDeepLink(text)), text).toEqual({ ok: false, reason: OPERATOR_LINK_REASON });
    }
  });

  it("refuses it after leading whitespace or hidden characters", () => {
    for (const raw of [
      buildDeepLink("   /operator list my sessions"),
      buildDeepLink("\t/operator list my sessions"),
      buildDeepLink("\n\n/operator list my sessions"),
      buildDeepLink(" /operator list my sessions"),
      "monocode-harness://new?prompt=%20%20/operator%20x",
      // Removed by cleaning before the match, so they cannot hide it.
      buildDeepLink("​/operator list my sessions"),
      buildDeepLink("‮/operator list my sessions"),
      buildDeepLink("\u0007/operator list my sessions"),
    ]) {
      expect(parseDeepLink(raw), raw).toEqual({ ok: false, reason: OPERATOR_LINK_REASON });
    }
  });

  it("an ordinary prompt still fills, and so does /operator that does not lead or is another word", () => {
    for (const text of [
      "Fix the tests",
      "Explain what /operator does",
      "/operatorx is not a command",
      "/monorepo layout, explain it",
      "/review this branch",
    ]) {
      expect(parseDeepLink(buildDeepLink(text)), text).toEqual({ ok: true, prompt: text, removed: 0 });
    }
  });
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deps(launch: string[]): DeepLinkDeps {
  return {
    isMainWindow: () => true,
    getCurrent: vi.fn(async () => launch),
    onOpenUrl: vi.fn(async () => () => {}),
    fill: vi.fn(),
    reveal: vi.fn(async () => {}),
    notify: vi.fn(),
    inbox: new DeepLinkInbox(null),
  };
}

describe("startDeepLinks and /operator", () => {
  it("does not put the prompt in the composer, and says why", async () => {
    const d = deps([buildDeepLink("  /Operator list my sessions")]);
    startDeepLinks(d);
    await flush();
    expect(d.fill).not.toHaveBeenCalled();
    expect(d.reveal).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith({ kind: "refused", reason: OPERATOR_LINK_REASON });
    expect(noticeText({ kind: "refused", reason: OPERATOR_LINK_REASON })).toBe(
      "A link was not used. A link cannot turn on app access. Type /operator yourself.",
    );
  });

  it("an ordinary link in the same delivery still fills", async () => {
    const d = deps([buildDeepLink("/monocode do it"), buildDeepLink("Fix the build")]);
    startDeepLinks(d);
    await flush();
    expect(d.fill).toHaveBeenCalledTimes(1);
    expect(d.fill).toHaveBeenCalledWith("Fix the build");
    expect(d.notify).toHaveBeenCalledWith({ kind: "refused", reason: OPERATOR_LINK_REASON });
    expect(d.notify).toHaveBeenLastCalledWith({ kind: "filled", removed: 0 });
  });
});
