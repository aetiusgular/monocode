import { Check, Loader, Minus } from "../../../shared/ui/icons";
import type { TaskListItem, TaskListItemStatus } from "../model/session";

/** One task with its status mark, shared by the inline card and the panel. */
export function TaskListRow({ item }: { item: TaskListItem }) {
  return (
    <li className="flex min-w-0 items-start gap-2.5 px-2.5 py-1.5">
      <TaskState status={item.status} />
      <span
        className={`min-w-0 flex-1 font-sans text-[12.5px] leading-4.5 ${
          item.status === "completed"
            ? "text-content/40 line-through decoration-content/25"
            : item.status === "cancelled"
              ? "text-content/35 line-through decoration-content/20"
              : item.status === "in_progress"
                ? "text-content/85"
                : "text-content/60"
        }`}
      >
        {item.text}
      </span>
    </li>
  );
}

export function TaskState({ status }: { status: TaskListItemStatus }) {
  if (status === "completed") {
    return (
      <span
        aria-label="Completed"
        className="mt-px grid size-4 shrink-0 place-items-center rounded-full bg-emerald-400/20 text-emerald-300"
      >
        <Check className="size-2.5" strokeWidth={2.5} />
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span
        aria-label="In progress"
        className="mt-px grid size-4 shrink-0 place-items-center text-sky-300"
      >
        <Loader className="size-4 motion-safe:animate-spin" strokeWidth={2} />
      </span>
    );
  }
  if (status === "cancelled") {
    return (
      <span
        aria-label="Cancelled"
        className="mt-px grid size-4 shrink-0 place-items-center rounded-full bg-content/8 text-content/35"
      >
        <Minus className="size-2.5" strokeWidth={2} />
      </span>
    );
  }
  return (
    <span
      aria-label="Pending"
      className="mt-px size-4 shrink-0 rounded-full border border-content/25 bg-content/[0.02]"
    />
  );
}
