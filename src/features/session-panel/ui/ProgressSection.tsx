import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "../../../shared/ui/icons";
import type { TaskListMeta } from "../../sessions/model/session";
import { TaskListRow } from "../../sessions/ui/TaskListRow";
import {
  earlierStepsToggleLabel,
  foldEarlierSteps,
  runningStepKey,
} from "../model/sessionProgress";
import { EmptyNote } from "./PanelSection";
import { edgeFadeMask, useScrollEdges } from "./useScrollEdges";

/**
 * The agent's task list, in a scroll area of its own so a long plan cannot
 * push the rest of the panel out of reach. Finished steps ahead of the work in
 * hand fold into one row, and the list keeps the running step in view until
 * the viewer scrolls somewhere else.
 */
export function ProgressSection({
  taskList,
}: {
  taskList: TaskListMeta | null;
}) {
  const [showEarlier, setShowEarlier] = useState(false);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const items = taskList?.items ?? [];
  const { earlier, rest } = foldEarlierSteps(items);
  const running = runningStepKey(items);
  const edges = useScrollEdges(
    scroller,
    `${items.length}:${showEarlier}:${running}`,
  );

  // Following stops once the viewer scrolls the running step out of view, and
  // picks up again when they bring it back.
  const following = useRef(true);
  useEffect(() => {
    if (!scroller) return;
    const onScroll = () => {
      const row = runningRow(scroller);
      following.current = !row || rowInView(scroller, row);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [scroller]);
  // Opening the fold moves the running step without a scroll. A viewer who
  // opened it to read the earlier steps is not following any more.
  const foldWas = useRef(showEarlier);
  useLayoutEffect(() => {
    if (!scroller || foldWas.current === showEarlier) return;
    foldWas.current = showEarlier;
    const row = runningRow(scroller);
    following.current = !row || rowInView(scroller, row);
  }, [scroller, showEarlier]);
  useLayoutEffect(() => {
    if (!scroller || !following.current) return;
    const row = runningRow(scroller);
    if (row && !rowInView(scroller, row)) bringIntoView(scroller, row);
  }, [scroller, running]);

  if (!taskList) {
    return (
      <div data-progress-steps className="px-2 pb-3">
        <EmptyNote>
          No task list yet. When the agent plans its work, the steps are pinned
          here.
        </EmptyNote>
      </div>
    );
  }
  return (
    <div
      ref={setScroller}
      data-progress-steps
      data-fade-above={edges.above || undefined}
      data-fade-below={edges.below || undefined}
      tabIndex={edges.above || edges.below ? 0 : undefined}
      aria-label="Steps"
      role="group"
      style={{
        maskImage: edgeFadeMask(edges),
        WebkitMaskImage: edgeFadeMask(edges),
      }}
      className="max-h-[min(21rem,40vh)] overflow-y-auto overscroll-contain px-2 pb-3 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
    >
      {taskList.explanation ? (
        <p className="line-clamp-2 px-2.5 pb-1.5 text-[11.5px] leading-4 text-content/50">
          {taskList.explanation}
        </p>
      ) : null}
      <ol>
        {earlier.length > 0 ? (
          <li className="relative">
            {/* The rail the folded steps hang from. */}
            <span
              aria-hidden
              className={`pointer-events-none absolute left-[17px] top-1.5 w-px bg-content/15 ${
                showEarlier ? "bottom-0" : "bottom-1.5"
              }`}
            />
            <button
              type="button"
              aria-expanded={showEarlier}
              data-earlier-steps
              className="group flex w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pl-9 pr-2.5 text-left hover:bg-content/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              onClick={() => setShowEarlier((shown) => !shown)}
            >
              <span className="min-w-0 truncate text-[12.5px] leading-4.5 text-content/50 group-hover:text-content/75">
                {earlierStepsToggleLabel(earlier.length, showEarlier)}
              </span>
              <ChevronRight
                className={`size-3.5 shrink-0 text-content/35 transition-transform duration-150 group-hover:text-content/60 ${
                  showEarlier ? "rotate-90" : ""
                }`}
                strokeWidth={1.75}
              />
            </button>
          </li>
        ) : null}
        {showEarlier
          ? earlier.map((item, index) => (
              <li
                key={item.id ?? `${index}:${item.text}`}
                data-earlier-step
                className="relative py-1.5 pl-9 pr-2.5 text-[12.5px] leading-4.5 text-content/55"
              >
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 left-[17px] w-px bg-content/15"
                />
                <span className="sr-only">Completed: </span>
                {item.text}
              </li>
            ))
          : null}
        {rest.map((item, index) => (
          <TaskListRow
            key={item.id ?? `${earlier.length + index}:${item.text}`}
            item={item}
          />
        ))}
      </ol>
    </div>
  );
}

function runningRow(scroller: HTMLElement): HTMLElement | null {
  return (
    scroller
      .querySelector<HTMLElement>('[aria-label="In progress"]')
      ?.closest("li") ?? null
  );
}

function rowInView(scroller: HTMLElement, row: HTMLElement): boolean {
  const area = scroller.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  return box.top >= area.top - 1 && box.bottom <= area.bottom + 1;
}

/** Scrolls only this area; `scrollIntoView` would move the transcript too. */
function bringIntoView(scroller: HTMLElement, row: HTMLElement) {
  const area = scroller.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  const middle = box.top - area.top - (area.height - box.height) / 2;
  scroller.scrollTop += middle;
}
