import type { HelperState } from "./client";
import type { OfferBlock } from "./offer";

/**
 * What the composer's computer-use control shows for a chat. Pure, so the
 * states are tested without rendering.
 */
export type ControlView = {
  /** Hidden where computer use can never run: off macOS, or a harness that
   * takes no servers from MonoCode (corner case 11: no dead controls). */
  visible: boolean;
  tone: "off" | "on" | "running" | "blocked";
  label: string;
  title: string;
  /** The stop control (C4): while a runtime runs or any app is granted. */
  showStop: boolean;
  /** Why the switch cannot work yet, in the popover. */
  note?: string;
};

export function controlView(input: {
  block?: OfferBlock;
  on: boolean;
  grants: number;
  running: boolean;
  helper: HelperState;
}): ControlView {
  if (input.block === "platform" || input.block === "harness" || input.block === "app") {
    return {
      visible: false,
      tone: "off",
      label: "",
      title: "",
      showStop: false,
    };
  }
  const showStop = input.running || input.grants > 0;
  const helperNote =
    input.helper === "missing"
      ? "MonoCode Computer Use is not installed beside MonoCode, so no app can be driven yet."
      : undefined;
  if (input.block === "vision") {
    return {
      visible: true,
      tone: "blocked",
      label: "Computer use",
      title: "Computer use: this model is not known to read images",
      showStop,
      note: "This model is not known to read images. Turn on \"Use without vision\" to offer computer use anyway; it then works from each app's accessibility tree.",
    };
  }
  if (!input.on) {
    return {
      visible: true,
      tone: "off",
      label: "Computer use",
      title: "Computer use is off for this chat",
      showStop,
      ...(helperNote ? { note: helperNote } : {}),
    };
  }
  const apps = input.grants === 1 ? "1 app" : `${input.grants} apps`;
  return {
    visible: true,
    tone: input.running ? "running" : "on",
    label: input.grants > 0 ? `Computer use · ${apps}` : "Computer use",
    title: input.running
      ? `Computer use is running with ${apps}`
      : input.grants > 0
        ? `Computer use is on with ${apps} approved`
        : "Computer use is on; the agent asks for each app",
    showStop,
    ...(helperNote ? { note: helperNote } : {}),
  };
}
