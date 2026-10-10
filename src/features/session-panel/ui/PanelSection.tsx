import { useId, useSyncExternalStore, type ReactNode } from "react";
import { ChevronRight } from "../../../shared/ui/icons";
import {
  loadSectionCollapsed,
  saveSectionCollapsed,
  SECTION_COLLAPSED_DEFAULT,
  subscribeSectionCollapsed,
  type SessionPanelSection,
} from "../model/sessionPanelState";

const HEADING = "text-[12.5px] font-medium text-content/90";

/**
 * One titled block of the panel. Given a `fold`, its heading is a button that
 * tucks the body away, and the panel remembers that the next time it opens.
 */
export function PanelSection({
  title,
  fold,
  action,
  children,
}: {
  title: string;
  fold?: SessionPanelSection;
  /** Sits at the right of the heading. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  const bodyId = useId();
  const collapsed = useSyncExternalStore(
    subscribeSectionCollapsed,
    () => (fold ? loadSectionCollapsed(fold) : false),
    () => (fold ? SECTION_COLLAPSED_DEFAULT[fold] : false),
  );
  return (
    <section
      aria-labelledby={headingId}
      data-panel-section={title}
      className="border-t border-content/8 px-2 pb-2.5 pt-2"
    >
      <div className="flex min-h-8 items-center gap-2 pr-1.5">
        {fold ? (
          <h4 id={headingId} className="min-w-0">
            <button
              type="button"
              aria-expanded={!collapsed}
              aria-controls={bodyId}
              className={`group flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 hover:bg-content/6 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${HEADING}`}
              onClick={() => saveSectionCollapsed(fold, !collapsed)}
            >
              <span className="truncate">{title}</span>
              <ChevronRight
                className={`size-3.5 shrink-0 text-content/40 transition-transform duration-150 group-hover:text-content/70 ${
                  collapsed ? "" : "rotate-90"
                }`}
                strokeWidth={1.75}
              />
            </button>
          </h4>
        ) : (
          <h4 id={headingId} className={`min-w-0 truncate px-2 ${HEADING}`}>
            {title}
          </h4>
        )}
        <span className="flex-1" />
        {action}
      </div>
      <div id={bodyId} hidden={collapsed}>
        {collapsed ? null : children}
      </div>
    </section>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 pb-1 text-[12px] leading-4.5 text-content/40">
      {children}
    </p>
  );
}
