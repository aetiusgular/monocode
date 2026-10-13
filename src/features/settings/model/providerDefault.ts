/**
 * The Use by default button on a Settings, Providers row. A provider whose
 * CLI is not found cannot start a chat, so it cannot be the default: the
 * button is off and says why (Mac 5.10). Before the first probe nothing is
 * known yet, and the button is not held off for a CLI that may be there.
 */
export function providerDefaultButton(input: {
  isDefault: boolean;
  hasModel: boolean;
  available: boolean;
  probed: boolean;
}): { label: string; disabled: boolean; reason?: string } {
  if (input.isDefault) return { label: "Default", disabled: true };
  if (input.probed && !input.available) {
    return {
      label: "Use by default",
      disabled: true,
      reason: "CLI not found",
    };
  }
  return { label: "Use by default", disabled: !input.hasModel };
}
