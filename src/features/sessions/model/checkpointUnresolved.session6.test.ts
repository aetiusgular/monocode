import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { checkpointSkippedNotice } = await import("./checkpoint");

describe("a checkpoint skipped because the repository top is unknown (F7)", () => {
  it("says why, not that the repository covers home", () => {
    expect(
      checkpointSkippedNotice({
        reason: "unresolvedRepository",
        repository: "/Users/t/broken checkout",
      }),
    ).toBe(
      "No checkpoint for this turn: the repository top folder for /Users/t/broken checkout could not be found, so it may cover your home folder.",
    );
    expect(
      checkpointSkippedNotice({
        reason: "homeRepository",
        repository: "/Users/t",
      }),
    ).toBe(
      "No checkpoint for this turn: the repository at /Users/t covers your home folder.",
    );
  });
});
