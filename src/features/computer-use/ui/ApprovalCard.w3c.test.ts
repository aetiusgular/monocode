import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApprovalCard } from "./ApprovalCard";

const session = { harness: "claude" as const, model: "claude:opus-5-5" };
const noop = async () => undefined;

describe("ApprovalCard", () => {
  it("renders outside text as text, never markup", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalCard, {
        app: { bundleId: "com.evil.app", name: "<img src=x onerror=alert(1)>" },
        reason: "<script>steal()</script>",
        session,
        onAllow: noop,
        onDeny: noop,
      }),
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("Allow for this chat");
  });

  it("shows the terminal warning and the screen note", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalCard, {
        app: { bundleId: "com.apple.Terminal", name: "Terminal", warning: "terminal" },
        session,
        onAllow: noop,
        onDeny: noop,
      }),
    );
    expect(html).toContain("runs commands as you");
    expect(html).toContain("not on this Mac");
  });

  it("offers only Deny when the app cannot be granted", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalCard, {
        app: undefined,
        refusal: "MonoCode never grants itself.",
        session,
        onAllow: noop,
        onDeny: noop,
      }),
    );
    expect(html).toContain("never grants itself");
    expect(html).not.toContain("Allow for this chat");
    expect(html).toContain("Deny");
  });
});
