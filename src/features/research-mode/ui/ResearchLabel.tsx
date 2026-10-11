import { Globe } from "../../../shared/ui/icons";

/** Marks a sent message that went out as research. */
export function ResearchLabel() {
  return (
    <span
      data-research-label
      title="Sent as research: the agent searches the web and writes a cited report"
      className="mt-2 flex w-fit items-center gap-1 text-[11px] leading-none text-teal-700 dark:text-teal-200/80"
    >
      <Globe className="size-3" />
      Research
    </span>
  );
}
