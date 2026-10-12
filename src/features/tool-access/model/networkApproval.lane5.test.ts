import { describe, expect, it } from "vitest";
import { newSession, type Block } from "../../sessions/model/session";
import { sanitizeSessionForPersist } from "../../sessions/data/sessionStore";
import { applyHarnessEvent } from "../../../integrations/harness/core/apply";
import { alwaysAllowHostOptions, networkApprovalView } from "./networkApproval";

const decided = (network: unknown): Block => ({
  id: "b1",
  role: "tool",
  text: "curl",
  tool: { callId: "c1", title: "curl", kind: "execute" },
  approval: {
    requestId: 3,
    decided: "allow",
    network: network as NonNullable<Block["approval"]>["network"],
  },
});

const savedNetwork = (network: unknown) => {
  const session = newSession("codex", "/tmp/a");
  session.blocks = [{ id: "u", role: "user", text: "hi" }, decided(network)];
  return sanitizeSessionForPersist(session).blocks[1]?.approval?.network;
};

describe("network approval view", () => {
  it("shows host and protocol, and always-allow only for a proposed allow on that host", () => {
    expect(
      networkApprovalView({
        requestId: 1,
        network: {
          host: "registry.npmjs.org",
          protocol: "https",
          amendments: [{ host: "registry.npmjs.org", action: "allow" }],
        },
      }),
    ).toEqual({
      host: "registry.npmjs.org",
      protocol: "HTTPS",
      alwaysAllowHost: "registry.npmjs.org",
    });
    expect(
      networkApprovalView({
        requestId: 1,
        network: {
          host: "a.example",
          protocol: "socks5Udp",
          amendments: [
            { host: "b.example", action: "allow" },
            { host: "a.example", action: "deny" },
          ],
        },
      }),
    ).toEqual({ host: "a.example", protocol: "SOCKS5 UDP" });
    expect(networkApprovalView({ requestId: 1 })).toBeNull();
    expect(networkApprovalView(undefined)).toBeNull();
    expect(alwaysAllowHostOptions("a.example")).toEqual({
      networkAmendment: { host: "a.example", action: "allow" },
    });
  });
});

describe("network approval on the block", () => {
  it("is carried from the event onto the approval", () => {
    const session = applyHarnessEvent(newSession("codex", "/tmp/a"), {
      type: "approval.requested",
      requestId: 9,
      title: "curl",
      kind: "execute",
      callId: "c9",
      network: {
        host: "example.com",
        protocol: "https",
        amendments: [{ host: "example.com", action: "allow" }],
      },
    });
    const approval = session.blocks.at(-1)?.approval;
    expect(approval?.network).toEqual({
      host: "example.com",
      protocol: "https",
      amendments: [{ host: "example.com", action: "allow" }],
    });
  });

  it("is saved clean and malicious values are dropped", () => {
    expect(
      savedNetwork({
        host: "example.com",
        protocol: "https",
        amendments: [
          { host: "example.com", action: "allow" },
          { host: "<script>", action: "allow" },
          { host: "x.example", action: "maybe" },
        ],
      }),
    ).toEqual({
      host: "example.com",
      protocol: "https",
      amendments: [{ host: "example.com", action: "allow" }],
    });
    expect(
      savedNetwork({ host: "<img src=x onerror=alert(1)>", protocol: "https" }),
    ).toBeUndefined();
    expect(
      savedNetwork({ host: "a".repeat(300), protocol: "https" }),
    ).toBeUndefined();
    expect(
      savedNetwork({ host: "example.com", protocol: "gopher" }),
    ).toBeUndefined();
    expect(savedNetwork("example.com")).toBeUndefined();
    const many = Array.from({ length: 20 }, (_, i) => ({
      host: `h${i}.example`,
      action: "allow",
    }));
    expect(
      savedNetwork({ host: "h0.example", protocol: "http", amendments: many })
        ?.amendments,
    ).toHaveLength(8);
  });
});
