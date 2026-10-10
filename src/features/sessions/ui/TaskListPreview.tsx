import { useId, useState } from "react";
import { ChevronRight, ListEnd } from "../../../shared/ui/icons";
import type { TaskListItem } from "../model/session";
import { currentTaskListItem, taskListProgressLabel } from "../model/taskList";
import { TaskListRow, TaskState } from "./TaskListRow";

type Props = {
  items: TaskListItem[];
  explanation?: string;
  /**
   * Identity of this list in the transcript, so a card the viewer opened is
   * still open after its row was unmounted and drawn again.
   */
  listKey?: string;
};

/**
 * Cards the viewer has opened, by list. Kept for this run of the app only: a
 * list starts folded each time the app does.
 */
const opened = new Set<string>();

/**
 * The agent's task list, inline in the transcript. It starts as one line that
 * names the step in hand and how far along the list is, and opens into the
 * full list on click, so a long plan does not take over the conversation.
 */
export function TaskListPreview({ items, explanation, listKey }: Props) {
  const listId = useId();
  const [open, setOpen] = useState(() =>
    listKey ? opened.has(listKey) : false,
  );
  const toggle = () => {
    const next = !open;
    if (listKey) {
      if (next) opened.add(listKey);
      else opened.delete(listKey);
    }
    setOpen(next);
  };
  const current = open ? null : currentTaskListItem(items);
  return (
    <section
      aria-label="Task progress"
      data-task-list={open ? "open" : "folded"}
      className="mb-2 overflow-hidden rounded-[10px] border border-content/10 bg-content/[0.035]"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        title={open ? "Hide the steps" : "Show the steps"}
        className={`group flex w-full items-start gap-2 px-2.5 py-2 text-left hover:bg-content/[0.03] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${
          open ? "border-b border-stroke" : ""
        }`}
        onClick={toggle}
      >
        <ListEnd
          className="mt-0.5 size-4 shrink-0 text-content/45"
          strokeWidth={1.75}
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="shrink-0 font-mono text-[12px] font-medium text-content/85">
              Tasks
            </span>
            {current ? (
              <span
                data-task-list-current
                className="flex min-w-0 flex-1 items-center gap-1.5"
              >
                <TaskState status={current.status} />
                <span
                  className={`min-w-0 truncate font-sans text-[12.5px] leading-4.5 ${
                    current.status === "in_progress"
                      ? "text-content/85"
                      : "text-content/60"
                  }`}
                >
                  {current.text}
                </span>
              </span>
            ) : (
              <span className="flex-1" />
            )}
            <span className="shrink-0 rounded-full bg-content/7 px-2 py-0.5 font-mono text-[10px] text-content/50">
              {taskListProgressLabel(items)}
            </span>
            <ChevronRight
              className={`size-3.5 shrink-0 text-content/40 transition-transform duration-150 group-hover:text-content/70 ${
                open ? "rotate-90" : ""
              }`}
              strokeWidth={1.75}
            />
          </span>
          {open && explanation ? (
            <span className="mt-0.5 line-clamp-2 block font-sans text-[11.5px] leading-4 text-content/50">
              {explanation}
            </span>
          ) : null}
        </span>
      </button>
      <div id={listId} hidden={!open}>
        {open ? (
          <ol className="py-1">
            {items.map((item, index) => (
              <TaskListRow
                key={item.id ?? `${index}:${item.text}`}
                item={item}
              />
            ))}
          </ol>
        ) : null}
      </div>
    </section>
  );
}

/** Forgets which cards were opened. For tests. */
export function resetOpenedTaskLists() {
  opened.clear();
}
