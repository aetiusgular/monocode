import { Settings } from "../../../shared/ui/icons";
import {
  Popover,
  type PopoverAnchor,
  type PopoverDismissReason,
} from "../../../shared/ui/Popover";
import { connectorChangePending } from "../../session-tools/model/connectors";
import { ConnectorSwitch } from "../../session-tools/ui/ConnectorSwitch";
import { chatPluginRows, setPluginOnForChat } from "../model/chatPlugins";
import { useChatPluginList } from "../model/chatPluginList";

const NOTE = "px-2 pb-0.5 pt-1 text-[11px] leading-4 text-content/45";

/**
 * The Claude Code plugins that load for this chat's folder, each with a
 * switch for this chat only. A plugin switched off here is passed to Claude
 * Code as `false` under `enabledPlugins` in the `--settings` the chat's
 * process starts with. Claude Code's own settings are never edited.
 */
export function PluginsPopover({
  anchor,
  cwd,
  accountId,
  disabled,
  atTurnStart,
  onChange,
  onManage,
  onDismiss,
}: {
  anchor: PopoverAnchor;
  /** The folder the chat's Claude Code runs in. */
  cwd: string;
  /** The Claude Code account the chat runs as. */
  accountId?: string;
  /** Plugin ids switched off for this chat. */
  disabled: string[];
  /** `disabled` as the running turn started, or null while idle. */
  atTurnStart: readonly string[] | null;
  onChange: (disabled: string[]) => void;
  /** Open Settings on the Plugins page. */
  onManage: () => void;
  onDismiss: (reason: PopoverDismissReason) => void;
}) {
  const list = useChatPluginList(cwd, accountId);
  const rows = chatPluginRows(list.plugins ?? [], disabled);
  const pending = connectorChangePending(disabled, atTurnStart);
  return (
    <Popover
      anchor={anchor}
      side="top"
      align="start"
      width={300}
      onDismiss={onDismiss}
      data-composer-plus
      role="dialog"
      aria-label="Plugins"
      className="p-1.5"
    >
      <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-content/40">
        Plugins
      </p>
      {rows.length > 0 ? (
        <ul
          aria-label="Plugins for this chat"
          className="max-h-[min(280px,40vh)] overflow-y-auto overscroll-contain"
        >
          {rows.map((row) => (
            <li
              key={row.id}
              data-chat-plugin={row.id}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5"
            >
              <span className="min-w-0 flex-1">
                <span
                  title={row.id}
                  className="block truncate text-[13px] text-content"
                >
                  {row.name}
                </span>
                <span
                  title={row.detail}
                  className="block truncate text-[11px] leading-4 text-content/45"
                >
                  {row.detail}
                </span>
              </span>
              {row.locked ? null : (
                <ConnectorSwitch
                  label={row.name}
                  on={row.on}
                  onChange={(on) =>
                    onChange(setPluginOnForChat(disabled, row.id, on))
                  }
                />
              )}
            </li>
          ))}
        </ul>
      ) : list.loading ? (
        <p className="px-2 py-2 text-[12px] text-content/50">
          Asking Claude Code…
        </p>
      ) : list.error ? null : (
        <p className="px-2 py-2 text-[12px] text-content/50">
          No plugins load for this chat
        </p>
      )}
      {list.error ? (
        <p
          role="alert"
          className="px-2 py-1 text-[11px] leading-4 text-red-400"
        >
          Could not list plugins: {list.error}
        </p>
      ) : null}
      {rows.some((row) => !row.on) ? (
        <p className={NOTE}>
          Off for this chat only. Your Claude Code settings stay as they are.
        </p>
      ) : null}
      {pending ? (
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
          Manage plugins
        </button>
      </div>
    </Popover>
  );
}
