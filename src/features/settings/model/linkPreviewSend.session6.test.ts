// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 5.9: a message sent while Link previews was off got its preview fetched
// later, when the switch was turned back on.

const fetched = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("../../sessions/model/linkPreview", async (original) => ({
  ...(await original<object>()),
  fetchLinkPreviewMetadata: async (url: string) => {
    fetched.urls.push(url);
    return null;
  },
}));

import {
  linkPreviewAllowedFor,
  linkPreviewsOnSince,
  resetOutboundCallsCache,
  setOutboundCallAllowed,
} from "./outboundCalls";
import {
  appendSteerUser,
  appendUser,
} from "../../../integrations/harness/core/apply";
import { newSession } from "../../sessions/model/session";
import { parseUserMessageLink } from "../../sessions/model/linkPreview";
import { UserLinkPreview } from "../../sessions/ui/UserLinkPreview";

beforeEach(() => {
  localStorage.clear();
  resetOutboundCallsCache();
  fetched.urls = [];
});
afterEach(() => vi.useRealTimers());

function render(message: Parameters<typeof linkPreviewAllowedFor>[0]) {
  const parsed = parseUserMessageLink("see https://example.com/page")!;
  return renderToStaticMarkup(
    createElement(UserLinkPreview, { link: parsed.link, message }),
  );
}

describe("link previews follow the switch at send time", () => {
  it("stamps each sent message with the switch", () => {
    let session = newSession("/tmp/not a repo");
    session = appendUser(session, "first https://example.com");
    setOutboundCallAllowed("link-previews", false);
    session = appendSteerUser(session, "second https://example.com");
    const users = session.blocks.filter((b) => b.role === "user");
    expect(users.map((b) => b.linkPreviews)).toEqual([true, false]);
  });

  it("keeps a message sent with previews off plain after they are turned on", () => {
    setOutboundCallAllowed("link-previews", false);
    const sent = appendUser(newSession("/tmp"), "https://example.com/page")
      .blocks[0]!;
    setOutboundCallAllowed("link-previews", true);
    expect(linkPreviewAllowedFor(sent)).toBe(false);
    expect(render(sent)).toContain("data-user-link-plain");
    // A message sent now does get its preview.
    const now = appendUser(newSession("/tmp"), "https://example.com/page")
      .blocks[0]!;
    expect(linkPreviewAllowedFor(now)).toBe(true);
    expect(render(now)).toContain("data-user-link-preview");
  });

  it("an older unstamped message counts by its send time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    setOutboundCallAllowed("link-previews", false);
    vi.setSystemTime(2_000_000);
    setOutboundCallAllowed("link-previews", true);
    expect(linkPreviewsOnSince()).toBe(2_000_000);
    expect(linkPreviewAllowedFor({ startedAt: 1_500_000 })).toBe(false);
    expect(linkPreviewAllowedFor({ sentAt: 2_500_000 })).toBe(true);
    expect(linkPreviewAllowedFor({})).toBe(false);
  });

  it("leaves messages from before any switch change as they were", () => {
    expect(linkPreviewsOnSince()).toBe(0);
    expect(linkPreviewAllowedFor({ startedAt: 5 })).toBe(true);
  });

  it("never previews while the switch is off, whatever the stamp", () => {
    setOutboundCallAllowed("link-previews", false);
    expect(linkPreviewAllowedFor({ linkPreviews: true })).toBe(false);
  });

  it("turning the switch on twice does not move the time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10);
    setOutboundCallAllowed("link-previews", false);
    vi.setSystemTime(20);
    setOutboundCallAllowed("link-previews", true);
    vi.setSystemTime(30);
    setOutboundCallAllowed("link-previews", true);
    expect(linkPreviewsOnSince()).toBe(20);
  });
});
