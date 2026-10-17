import {
  harnessIsHosted,
  modelRoutePart,
  type LocalitySession,
} from "../../server-locality/model/locality";
import type { AppInfo, AppWarning } from "./client";

/**
 * What the approval card for one app says (C2, C5). Plain strings: the card
 * renders them as text, never as markup, and the app name and the agent's
 * reason come from outside and are shown as given, on one line each.
 */
export type CardText = {
  title: string;
  /** The app as granted: its name and bundle id. */
  app: string;
  /** The agent's reason, quoted as its words. Empty when it gave none. */
  reason: string;
  /** Always shown. */
  scope: string;
  /** Where screenshots go. */
  screen: string;
  /** The extra warning for a terminal, Finder or System Settings. */
  warning?: string;
  /** Shown when the chat runs without a model known to read images. */
  vision?: string;
  allow: string;
  deny: string;
};

const WARNING_TEXT: Record<AppWarning, string> = {
  terminal:
    "This is a terminal. Typing into it runs commands as you, outside every sandbox and approval rule in MonoCode.",
  finder:
    "Finder can open, move, rename and delete any file you can, in any folder.",
  systemSettings:
    "System Settings can change privacy grants, the firewall, users and passwords.",
};

/** Whether screenshots from this chat reach a model that is not on this Mac. */
export function screenLeavesMac(session: LocalitySession): boolean {
  if (harnessIsHosted(session.harness)) return true;
  return modelRoutePart(session).locality !== "local";
}

export function cardText(input: {
  app: AppInfo;
  /** The agent's own words, when it asked. Absent when you added the app. */
  reason?: string;
  session: LocalitySession;
  /** The chat's switch says to run without a vision model. */
  withoutVision?: boolean;
}): CardText {
  const name = oneLine(input.app.name || input.app.bundleId);
  const hosted = screenLeavesMac(input.session);
  return {
    title: `Allow this chat to use ${name}?`,
    app:
      input.app.name && input.app.name !== input.app.bundleId
        ? `${oneLine(input.app.name)} (${input.app.bundleId})`
        : input.app.bundleId,
    reason: input.reason ? oneLine(input.reason) : "",
    scope: `The agent can see ${name}'s windows and click and type in it, outside the chat's sandbox. Its folders, network and permission mode do not change. Until you stop computer use or quit MonoCode.`,
    screen: hosted
      ? `Screenshots of ${name} go to the chat's model, which is not on this Mac: the provider sees them.`
      : `Screenshots of ${name} go to the chat's model on this Mac.`,
    ...(input.app.warning ? { warning: WARNING_TEXT[input.app.warning] } : {}),
    ...(input.withoutVision
      ? {
          vision:
            "This model is not known to read images. It works from the app's accessibility tree, so canvas, video and custom-drawn apps will not work.",
        }
      : {}),
    allow: "Allow for this chat",
    deny: "Deny",
  };
}

/** One line, no control or direction characters, at most 200 characters. */
export function oneLine(text: string): string {
  return Array.from(text.replace(/\s+/g, " "))
    .filter((c) => !/[\p{Cc}​-‏‪-‮⁠-⁤﻿]/u.test(c))
    .slice(0, 200)
    .join("")
    .trim();
}
