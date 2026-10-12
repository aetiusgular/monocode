import { describe, expect, it } from "vitest";
import { sanitizeSessionForPersist } from "./sessionStore";
import { newSession, type Block } from "../model/session";
import type { BackgroundItem } from "../../../integrations/harness/core/background";

function persisted(blocks: Block[]) {
  return sanitizeSessionForPersist({
    ...newSession("claude", "/repo"),
    blocks,
  }).blocks;
}

describe("checkpointTurnId on saved blocks", () => {
  it("survives a save on a user block", () => {
    const [block] = persisted([
      {
        id: "u1",
        role: "user",
        text: "fix it",
        checkpointTurnId: "6f1c2a0e-1b2c-4d5e-8f90-123456789abc",
      },
    ]);
    expect(block.checkpointTurnId).toBe(
      "6f1c2a0e-1b2c-4d5e-8f90-123456789abc",
    );
  });

  it("drops an id the checkpoint store would refuse", () => {
    for (const bad of ["../escape", "a b", "x".repeat(200), "", "id\n"]) {
      const [block] = persisted([
        { id: "u1", role: "user", text: "fix it", checkpointTurnId: bad },
      ]);
      expect(block.checkpointTurnId).toBeUndefined();
    }
  });

  it("is kept on user blocks only", () => {
    const [block] = persisted([
      { id: "a1", role: "assistant", text: "done", checkpointTurnId: "cp-1" },
    ]);
    expect(block.checkpointTurnId).toBeUndefined();
  });

  it("never saves the live Running items", () => {
    const items: BackgroundItem[] = [
      {
        id: "b1",
        kind: "shell",
        title: "npm test",
        status: "running",
        stoppable: true,
        source: "harness",
      },
    ];
    const payload = sanitizeSessionForPersist({
      ...newSession("claude", "/repo"),
      backgroundItems: items,
      blocks: [{ id: "u1", role: "user", text: "hi" }],
    });
    expect(JSON.stringify(payload)).not.toContain("npm test");
  });
});
