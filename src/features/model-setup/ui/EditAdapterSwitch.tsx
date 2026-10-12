import {
  editAdapterAvailability,
  editAdapterOn,
} from "../model/editAdapter";
import {
  setProviderEditAdapter,
  type ModelProviderEntry,
} from "../model/modelProviders";

const HELP =
  "Gives the model plain edit_file and write_file tools and turns each call into Codex's own patch, so small models can edit. Codex still asks before each change, as set for the chat. Takes effect on the next chat or after the chat reopens.";

/**
 * "Edit adapter for small models" on one provider row of the Models page.
 * Shown for local providers only. The default follows the model's tool
 * calling trait, and the label says when the default is in force.
 */
export function EditAdapterSwitch({ entry }: { entry: ModelProviderEntry }) {
  const availability = editAdapterAvailability(entry);
  if (!availability.available) {
    if (availability.reason.startsWith("Only for")) return null;
    return (
      <span
        className="shrink-0 text-[11px] text-content/40"
        title={availability.reason}
        data-edit-adapter="unavailable"
      >
        Edit adapter unavailable
      </span>
    );
  }
  const on = editAdapterOn(entry);
  return (
    <label
      className="flex shrink-0 items-center gap-1 text-[11px] text-content/60"
      title={HELP}
      data-edit-adapter={on ? "on" : "off"}
    >
      <input
        type="checkbox"
        checked={on}
        onChange={(event) =>
          setProviderEditAdapter(entry.id, event.currentTarget.checked)
        }
      />
      Edit adapter for small models
      {entry.editAdapter === undefined ? (
        <span className="text-content/35">(default)</span>
      ) : null}
    </label>
  );
}
