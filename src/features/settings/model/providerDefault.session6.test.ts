import { describe, expect, it } from "vitest";
import { providerDefaultButton } from "./providerDefault";

// Mac 5.10: Settings, Providers offered an enabled "Use by default" on
// Cursor, Grok Build, OpenCode, Pi and omp, whose CLIs were not found (only
// Claude Code and Codex installed).

describe("Use by default on a provider row", () => {
  it("is off with the reason when the CLI is not found", () => {
    expect(
      providerDefaultButton({
        isDefault: false,
        hasModel: true,
        available: false,
        probed: true,
      }),
    ).toEqual({
      label: "Use by default",
      disabled: true,
      reason: "CLI not found",
    });
  });

  it("is on for an installed CLI with a model", () => {
    expect(
      providerDefaultButton({
        isDefault: false,
        hasModel: true,
        available: true,
        probed: true,
      }),
    ).toEqual({ label: "Use by default", disabled: false });
  });

  it("is not held off before the first probe", () => {
    expect(
      providerDefaultButton({
        isDefault: false,
        hasModel: true,
        available: false,
        probed: false,
      }).disabled,
    ).toBe(false);
  });

  it("stays Default on the default provider, found or not", () => {
    for (const available of [true, false]) {
      expect(
        providerDefaultButton({
          isDefault: true,
          hasModel: true,
          available,
          probed: true,
        }),
      ).toEqual({ label: "Default", disabled: true });
    }
  });

  it("is off with no model to start with", () => {
    expect(
      providerDefaultButton({
        isDefault: false,
        hasModel: false,
        available: true,
        probed: true,
      }).disabled,
    ).toBe(true);
  });
});
