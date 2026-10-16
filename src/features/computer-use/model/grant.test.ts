import { describe, expect, it } from "vitest";
import { grantHoldsAt, type ComputerUseGrant } from "./grant";

describe("grantHoldsAt", () => {
  const grant: ComputerUseGrant = {
    chatId: "c1",
    bundleId: "com.apple.calculator",
    grantedAt: 100,
  };

  it("holds from the moment it is granted while it has no end", () => {
    expect(grantHoldsAt(grant, 99)).toBe(false);
    expect(grantHoldsAt(grant, 100)).toBe(true);
    expect(grantHoldsAt(grant, 1e12)).toBe(true);
  });

  it("stops holding at its end", () => {
    const ended = { ...grant, endedAt: 200 };
    expect(grantHoldsAt(ended, 199)).toBe(true);
    expect(grantHoldsAt(ended, 200)).toBe(false);
  });
});
