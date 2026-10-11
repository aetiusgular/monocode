import { playCue } from "../../settings/model/sounds";
import type { ToolChoice } from "../model/toolAccess";

const CHOICES: Array<{ value: ToolChoice; label: string }> = [
  { value: "always", label: "Always" },
  { value: "ask", label: "Ask" },
  { value: "never", label: "Never" },
];

/** A rule stands out from "Ask", which is the absence of one. */
const SELECTED: Record<ToolChoice, string> = {
  always: "bg-accent/20 text-content",
  ask: "bg-selection text-content",
  never: "bg-red-400/15 text-red-400",
};

/**
 * The three-way choice for one tool. It repeats the segmented control of the
 * Settings pages, which is private to the lazily loaded Settings view.
 */
export function ToolAccessControl({
  label,
  value,
  onChange,
}: {
  /** The tool's name, for the group's accessible name. */
  label: string;
  value: ToolChoice;
  onChange: (value: ToolChoice) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={`${label} access`}
      className="inline-grid shrink-0 grid-cols-3 gap-0.5 rounded-md border border-content/10 p-0.5 text-[11px]"
    >
      {CHOICES.map((choice) => (
        <button
          key={choice.value}
          type="button"
          role="radio"
          aria-checked={value === choice.value}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (value === choice.value) return;
            onChange(choice.value);
            playCue("switch");
          }}
          className={`rounded-[5px] px-1.5 py-0.5 ${
            value === choice.value
              ? SELECTED[choice.value]
              : "text-content/50 hover:text-content"
          }`}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}
