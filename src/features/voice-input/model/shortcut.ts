import { keybindingPressed } from "../../settings/model/settings";

/** Listed in Settings, Keybindings, where it can be rebound or turned off. */
export const VOICE_INPUT_COMMAND = "Composer: Voice Input";

type KeyEventLike = {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

/**
 * ⌘⇧M by default. Nothing in MonoCode's keybinding table, its native menu or
 * macOS's standard menus uses it (⌘M alone is Minimize).
 */
export function voiceShortcutPressed(event: KeyEventLike): boolean {
  const defaultMatch =
    event.metaKey &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    event.key.toLowerCase() === "m";
  return keybindingPressed(VOICE_INPUT_COMMAND, event, defaultMatch);
}
