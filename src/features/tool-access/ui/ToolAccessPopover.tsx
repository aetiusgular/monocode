import {
  Popover,
  type PopoverAnchor,
  type PopoverDismissReason,
} from "../../../shared/ui/Popover";
import {
  HARNESS_TITLE,
  type Block,
  type HarnessId,
  type ToolAccess,
} from "../../sessions/model/session";
import {
  harnessToolAccess,
  setToolChoice,
  toolAccessCaveats,
} from "../model/toolAccess";
import { toolAccessRows } from "../model/toolAccessRows";
import { ToolAccessControl } from "./ToolAccessControl";

const NOTE = "px-2 pb-0.5 pt-1 text-[11px] leading-4 text-content/45";

/**
 * The tools of the session's harness, each with this chat's rule: always
 * allow, ask, or never allow. "Ask" is no rule, so the permission mode
 * decides. Nothing here edits the harness's own configuration.
 */
export function ToolAccessPopover({
  anchor,
  harness,
  toolAccess,
  blocks,
  onChange,
  onDismiss,
}: {
  anchor: PopoverAnchor;
  harness: HarnessId;
  /** This chat's rules. */
  toolAccess: ToolAccess | undefined;
  /** The transcript, for the tools this chat has met. */
  blocks: readonly Block[];
  onChange: (toolAccess: ToolAccess) => void;
  onDismiss: (reason: PopoverDismissReason) => void;
}) {
  const rows = toolAccessRows(harness, toolAccess, blocks);
  const hasRules = rows.some((row) => row.choice !== "ask");
  const title = HARNESS_TITLE[harness];
  return (
    <Popover
      anchor={anchor}
      side="top"
      align="start"
      width={330}
      onDismiss={onDismiss}
      data-composer-plus
      role="dialog"
      aria-label="Tool access"
      className="p-1.5"
    >
      <div className="flex items-center justify-between px-2 pb-1 pt-0.5">
        <p className="text-[10px] font-medium uppercase tracking-wide text-content/40">
          Tool access
        </p>
        {hasRules ? (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChange({})}
            className="rounded text-[11px] text-content/45 hover:text-content"
          >
            Reset all
          </button>
        ) : null}
      </div>
      <ul
        aria-label={`${title} tools`}
        className="max-h-[min(336px,45vh)] overflow-y-auto overscroll-contain"
      >
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5"
          >
            <span className="min-w-0 flex-1">
              <span
                title={row.label}
                className="block truncate text-[13px] text-content"
              >
                {row.label}
              </span>
              <span className="block truncate text-[11px] leading-4 text-content/45">
                {row.detail}
              </span>
            </span>
            <ToolAccessControl
              label={row.label}
              value={row.choice}
              allowOnly={row.allowOnly}
              onChange={(choice) =>
                onChange(setToolChoice(toolAccess, row.key, choice))
              }
            />
          </li>
        ))}
      </ul>
      <p className={NOTE}>Ask follows this chat's permission mode.</p>
      {toolAccessCaveats(harness, harnessToolAccess(harness, toolAccess)).map(
        (caveat) => (
          <p key={caveat} className={NOTE}>
            {caveat}
          </p>
        ),
      )}
    </Popover>
  );
}
