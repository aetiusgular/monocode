import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

import { unavailableRateLimits } from "../../features/providers/model/rateLimits";
import { OUTBOUND_CALL_OFF_MESSAGE } from "../../features/settings/model/outboundCalls";
import { needsProviderLogin, usageSwitchedOff } from "./UsageProviderChip";

// Mac finding 5.9: with Usage figures off, the footer read "not connected"
// and offered a sign-in, though nothing was wrong with the sign-in.
describe("usage figures switched off", () => {
  it("is told apart from a lost sign-in", () => {
    const off = unavailableRateLimits("claude", OUTBOUND_CALL_OFF_MESSAGE);
    expect(usageSwitchedOff(off)).toBe(true);
    expect(needsProviderLogin(off)).toBe(false);
  });

  it("a real missing sign-in still asks to sign in", () => {
    const signedOut = unavailableRateLimits("codex", "Codex not signed in");
    expect(usageSwitchedOff(signedOut)).toBe(false);
    expect(needsProviderLogin(signedOut)).toBe(true);
  });
});
