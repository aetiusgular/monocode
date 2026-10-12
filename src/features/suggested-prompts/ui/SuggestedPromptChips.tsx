import { Sparkles, X } from "../../../shared/ui/icons";
import type { SuggestedPrompt } from "../model/suggestions";

/**
 * Chips above the composer input (#46). A click fills the composer with the
 * prompt and focuses it; the user sends it, edits it, or clears it. The
 * close button hides the chips for this chat.
 */
export function SuggestedPromptChips({
  prompts,
  onPick,
  onDismiss,
}: {
  prompts: readonly SuggestedPrompt[];
  onPick: (prompt: SuggestedPrompt) => void;
  onDismiss: () => void;
}) {
  if (prompts.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 px-3 pt-2"
      data-suggested-prompts
      aria-label="Suggested prompts"
    >
      <Sparkles className="size-3 shrink-0 text-content/35" />
      {prompts.map((prompt) => (
        <button
          key={prompt.id}
          type="button"
          title={prompt.prompt}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(prompt)}
          className="max-w-[16rem] truncate rounded-md border border-content/12 px-2 py-0.5 text-[11px] leading-4 text-content/70 hover:bg-content/8 hover:text-content"
        >
          {prompt.label}
        </button>
      ))}
      <button
        type="button"
        title="Hide suggestions in this chat"
        aria-label="Hide suggestions in this chat"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onDismiss}
        className="grid size-4 shrink-0 place-items-center rounded-full text-content/40 hover:bg-content/15 hover:text-content"
      >
        <X className="size-3" strokeWidth={2} />
      </button>
    </div>
  );
}
