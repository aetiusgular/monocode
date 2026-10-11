import { Settings } from "../../../shared/ui/icons";
import {
  Popover,
  type PopoverAnchor,
  type PopoverDismissReason,
} from "../../../shared/ui/Popover";
import { connectorChangePending } from "../../session-tools/model/connectors";
import { ConnectorSwitch } from "../../session-tools/ui/ConnectorSwitch";
import type { HarnessId } from "../../sessions/model/session";
import type { Skill } from "../../skills/model/skills";
import {
  chatSkillRows,
  chatSkillsCaveat,
  setSkillEnabled,
} from "../model/chatSkills";

const NOTE = "px-2 pb-0.5 pt-1 text-[11px] leading-4 text-content/45";

/**
 * The skills this chat can invoke with `/name`, each with a switch for this
 * chat. A skill switched off here leaves the chat's `/` list and its `/name`
 * is no longer expanded. The app-wide list in Settings is never edited.
 */
export function SkillsPopover({
  anchor,
  harness,
  skills,
  disabled,
  atTurnStart,
  onChange,
  onManage,
  onDismiss,
}: {
  anchor: PopoverAnchor;
  harness: HarnessId;
  /** The catalog for the chat's harness and project. */
  skills: readonly Skill[];
  /** Skill names switched off for this chat. */
  disabled: string[];
  /** `disabled` as the running turn started, or null while idle. */
  atTurnStart: readonly string[] | null;
  onChange: (disabled: string[]) => void;
  /** Open Settings on the Skills page. */
  onManage: () => void;
  onDismiss: (reason: PopoverDismissReason) => void;
}) {
  const rows = chatSkillRows(skills, disabled);
  // Only Claude Code takes the switches as a launch setting. The `/` list
  // and prompt expansion follow them at once on every harness.
  const claudePending =
    harness === "claude" && connectorChangePending(disabled, atTurnStart);
  return (
    <Popover
      anchor={anchor}
      side="top"
      align="start"
      width={300}
      onDismiss={onDismiss}
      data-composer-plus
      role="dialog"
      aria-label="Skills"
      className="p-1.5"
    >
      <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-content/40">
        Skills
      </p>
      {rows.length > 0 ? (
        <ul
          aria-label="Skills for this chat"
          className="max-h-[min(280px,40vh)] overflow-y-auto overscroll-contain"
        >
          {rows.map((row) => (
            <li
              key={row.name}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5"
            >
              <span className="min-w-0 flex-1">
                <span
                  title={`/${row.name}`}
                  className="block truncate text-[13px] text-content"
                >
                  /{row.name}
                </span>
                <span
                  title={row.detail}
                  className="block truncate text-[11px] leading-4 text-content/45"
                >
                  {row.detail}
                </span>
              </span>
              <ConnectorSwitch
                label={row.name}
                on={row.enabled}
                onChange={(on) =>
                  onChange(setSkillEnabled(disabled, row.name, on))
                }
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2 py-2 text-[12px] text-content/50">
          No skills found for this chat
        </p>
      )}
      {rows.some((row) => !row.enabled) ? (
        <p className={NOTE}>{chatSkillsCaveat(harness)}</p>
      ) : null}
      {claudePending ? (
        <p className={NOTE}>Claude Code follows from the next turn.</p>
      ) : null}
      <div className="mt-1 border-t border-content/10 pt-1">
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onManage}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content/65 hover:bg-content/10 hover:text-content"
        >
          <Settings className="size-3.5 shrink-0" />
          Manage skills
        </button>
      </div>
    </Popover>
  );
}
