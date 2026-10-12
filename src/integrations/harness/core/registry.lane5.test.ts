import { describe, expect, it, vi } from "vitest";
import {
  registerHarness,
  respondHarnessApproval,
  type HarnessAdapter,
} from "./registry";

function stub(
  respondApproval: HarnessAdapter["respondApproval"],
): HarnessAdapter {
  return {
    id: "cursor",
    live: true,
    async sendTurn() {},
    async steerTurn() {},
    async cancelTurn() {},
    respondApproval,
    async stopSession() {},
    async forgetSession() {},
    bindSession() {},
  };
}

describe("approval options", () => {
  it("reach a harness that is not Codex without changing the answer", () => {
    const seen: unknown[][] = [];
    // An adapter that only takes three arguments, like every non-Codex one.
    const respond = vi.fn(
      (sessionId: string, requestId: number, decision: "allow" | "deny") => {
        seen.push([sessionId, requestId, decision]);
      },
    );
    registerHarness(stub(respond));
    respondHarnessApproval("cursor", "s", 1, "allow", {
      networkAmendment: { host: "a.example", action: "allow" },
    });
    respondHarnessApproval("cursor", "s", 2, "allow");
    expect(seen).toEqual([
      ["s", 1, "allow"],
      ["s", 2, "allow"],
    ]);
    // Without options the call keeps its three-argument form.
    expect(respond.mock.calls[1]).toHaveLength(3);
  });
});
