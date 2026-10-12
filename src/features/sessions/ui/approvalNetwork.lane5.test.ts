import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { newSession, type Block } from "../model/session";
import { ApprovalControls } from "./AgentTranscript";
import { ApprovalToastCard } from "./ApprovalToasts";

const HOST = "registry.npmjs.org";

const block = (network: NonNullable<Block["approval"]>["network"]): Block => ({
  id: "b1",
  role: "tool",
  text: "curl",
  approval: { requestId: 4, network },
});

describe("network approval card", () => {
  it("shows host, protocol and the always-allow choice as plain text", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalControls, {
        block: block({
          host: HOST,
          protocol: "https",
          amendments: [{ host: HOST, action: "allow" }],
        }),
        onApproval: vi.fn(),
      }),
    );
    expect(html).toContain(HOST);
    expect(html).toContain("HTTPS");
    expect(html).toContain(`Always allow ${HOST}`);
    expect(html).not.toContain("<a ");
  });

  it("has no always-allow choice when no allow was proposed for the host", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalControls, {
        block: block({
          host: HOST,
          protocol: "http",
          amendments: [{ host: HOST, action: "deny" }],
        }),
        onApproval: vi.fn(),
      }),
    );
    expect(html).toContain(HOST);
    expect(html).not.toContain("Always allow");
  });

  it("escapes a hostile host that reached the card", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalControls, {
        block: block({
          host: "<img src=x onerror=alert(1)>",
          protocol: "https",
        }),
        onApproval: vi.fn(),
      }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("shows the host on the toast", () => {
    const session = { ...newSession("codex", "/tmp/a"), id: "s1" };
    const b = block({
      host: HOST,
      protocol: "https",
      amendments: [{ host: HOST, action: "allow" }],
    });
    const html = renderToStaticMarkup(
      createElement(ApprovalToastCard, {
        notice: {
          sessionId: "s1",
          requestId: 4,
          label: "curl",
          kind: "approval",
          block: b,
          session,
        },
        onFocusSession: vi.fn(),
        onApproval: vi.fn(),
      }),
    );
    expect(html).toContain(`Network access to ${HOST} (HTTPS)`);
    expect(html).toContain(`Always allow ${HOST}`);
  });
});
