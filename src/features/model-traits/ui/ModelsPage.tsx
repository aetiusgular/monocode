import { useMemo, useState, useSyncExternalStore } from "react";
import {
  allModels,
  getModelSnapshot,
  subscribeModels,
  type AgentModel,
  type ToolCalling,
} from "../../sessions/model/models";
import { HARNESS_TITLE } from "../../sessions/model/session";
import {
  clearTraitOverride,
  loadTraitOverrides,
  MAX_CONTEXT_WINDOW,
  MIN_CONTEXT_WINDOW,
  modelTraits,
  sanitizeContextWindow,
  sanitizeModelId,
  saveTraitOverride,
  useTraitOverridesVersion,
  type TraitSource,
} from "../model/modelTraits";

const NOTE = "text-[11px] leading-4 text-content/45";
const SELECT =
  "h-7 rounded-md border border-content/10 bg-transparent px-1.5 text-[12px] text-content";

const SOURCE_LABEL: Record<TraitSource, string> = {
  yours: "set by you",
  catalog: "from the catalog",
  harness: "known for this harness",
  unknown: "unknown",
};

/**
 * Models whose traits a catalog cannot be trusted for. Claude models are
 * known, so they are left out. Everything else is listed, with your entries
 * for ids no catalog knows at the end.
 */
export function modelsToList(
  models: readonly AgentModel[],
  overrideIds: readonly string[],
): { id: string; name: string; harnessLabel: string }[] {
  const seen = new Set<string>();
  const rows: { id: string; name: string; harnessLabel: string }[] = [];
  for (const model of models) {
    if (model.harness === "claude" || !model.id || seen.has(model.id)) continue;
    seen.add(model.id);
    rows.push({
      id: model.id,
      name: model.name,
      harnessLabel: HARNESS_TITLE[model.harness] ?? model.harness,
    });
  }
  for (const id of overrideIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, name: id, harnessLabel: "Added by you" });
  }
  return rows;
}

function ModelRow({
  id,
  name,
  harnessLabel,
}: {
  id: string;
  name: string;
  harnessLabel: string;
}) {
  const traits = modelTraits(id);
  // What the model gets without your entry, for the "Default" choices.
  const defaults = modelTraits(id, {});
  const yours = loadTraitOverrides()[id];
  const [windowDraft, setWindowDraft] = useState<string>(
    yours?.contextWindow ? String(yours.contextWindow) : "",
  );
  const windowInvalid =
    windowDraft.trim() !== "" &&
    sanitizeContextWindow(Number(windowDraft.trim())) === undefined;

  return (
    <li
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-content/10 p-2.5"
      data-model-traits-row={id}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-[13px] text-content" title={id}>
          {name}
        </span>
        <span className="shrink-0 text-[11px] text-content/35">
          {harnessLabel}
        </span>
        {yours ? (
          <button
            type="button"
            onClick={() => {
              clearTraitOverride(id);
              setWindowDraft("");
            }}
            className="ml-auto shrink-0 rounded-md px-1.5 text-[11px] text-content/45 hover:bg-content/8 hover:text-content/70"
          >
            Clear
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-content/60">
        <label className="flex items-center gap-1.5">
          Images
          <select
            aria-label={`Images for ${name}`}
            className={SELECT}
            value={
              yours?.vision === undefined ? "" : yours.vision ? "yes" : "no"
            }
            onChange={(event) =>
              saveTraitOverride(id, {
                vision:
                  event.target.value === ""
                    ? undefined
                    : event.target.value === "yes",
              })
            }
          >
            <option value="">
              Default (
              {defaults.vision === undefined
                ? "unknown"
                : defaults.vision
                  ? "yes"
                  : "no"}
              )
            </option>
            <option value="yes">Reads images</option>
            <option value="no">Text only</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          Tool calls
          <select
            aria-label={`Tool calls for ${name}`}
            className={SELECT}
            value={yours?.tools ?? ""}
            onChange={(event) =>
              saveTraitOverride(id, {
                tools:
                  event.target.value === ""
                    ? undefined
                    : (event.target.value as ToolCalling),
              })
            }
          >
            <option value="">Default ({defaults.tools})</option>
            <option value="reliable">Reliable</option>
            <option value="weak">Weak</option>
            <option value="none">None</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            aria-label={`${name} is slow`}
            checked={traits.slow}
            onChange={(event) =>
              saveTraitOverride(id, { slow: event.target.checked })
            }
          />
          Slow
        </label>
        <label className="flex items-center gap-1.5">
          Context window
          <input
            type="text"
            inputMode="numeric"
            aria-label={`Context window for ${name}`}
            aria-invalid={windowInvalid || undefined}
            placeholder={
              traits.source.contextWindow === "catalog" && traits.contextWindow
                ? String(traits.contextWindow)
                : "tokens"
            }
            value={windowDraft}
            onChange={(event) => setWindowDraft(event.target.value)}
            onBlur={() => {
              const raw = windowDraft.trim();
              if (raw === "") {
                saveTraitOverride(id, { contextWindow: undefined });
                return;
              }
              const value = sanitizeContextWindow(Number(raw));
              if (value !== undefined)
                saveTraitOverride(id, { contextWindow: value });
            }}
            className={`h-7 w-24 rounded-md border bg-transparent px-1.5 text-[12px] text-content ${windowInvalid ? "border-red-400/60" : "border-content/10"}`}
          />
        </label>
      </div>
      <p className={NOTE}>
        Images {SOURCE_LABEL[traits.source.vision]}. Tool calls{" "}
        {SOURCE_LABEL[traits.source.tools]}. Context window{" "}
        {traits.contextWindow
          ? `${traits.contextWindow.toLocaleString()} tokens, ${SOURCE_LABEL[traits.source.contextWindow]}`
          : "unknown"}
        .
        {windowInvalid
          ? ` Enter a whole number from ${MIN_CONTEXT_WINDOW.toLocaleString()} to ${MAX_CONTEXT_WINDOW.toLocaleString()}.`
          : ""}
      </p>
    </li>
  );
}

/**
 * Settings, Models: what MonoCode may assume about each model. A local
 * model's catalog entry is a default, so its traits stay unknown until you set
 * them here. Features that need images or tool calls stay off for a model
 * marked unknown.
 */
export function ModelsPage() {
  useSyncExternalStore(subscribeModels, getModelSnapshot, getModelSnapshot);
  const overridesVersion = useTraitOverridesVersion();
  const [newId, setNewId] = useState("");
  const rows = useMemo(
    () => modelsToList(allModels(), Object.keys(loadTraitOverrides())),
    // The catalog snapshot and the override version both change the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overridesVersion, getModelSnapshot()],
  );
  const addId = sanitizeModelId(newId);

  return (
    <div className="flex flex-col gap-3" data-models-page>
      <p className="text-[12px] text-content/50">
        What MonoCode may assume about each model. A local model's catalog entry
        is a default and can be wrong, so set its traits here. Claude models are
        known and not listed. Nothing here is sent anywhere.
      </p>
      {/* [lane-1] models-page */}
      {/* [lane-2] models-page */}
      {/* [lane-3] models-page */}
      {/* [lane-4] models-page */}
      {/* [lane-5] models-page */}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!addId) return;
          saveTraitOverride(addId, { tools: "unknown" });
          setNewId("");
        }}
      >
        <input
          type="text"
          aria-label="Model id"
          placeholder="codex:qwen2.5:7b"
          value={newId}
          onChange={(event) => setNewId(event.target.value)}
          className="h-7 min-w-48 flex-1 rounded-md border border-content/10 bg-transparent px-2 text-[12px] text-content"
        />
        <button
          type="submit"
          disabled={!addId}
          className="h-7 rounded-md border border-content/10 px-2.5 text-[12px] text-content/70 hover:bg-content/8 disabled:opacity-40"
        >
          Add a model
        </button>
      </form>
      {rows.length === 0 ? (
        <p className="text-[12px] text-content/45">
          No models besides Claude's are known yet. Add one by its id.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <ModelRow key={row.id} {...row} />
          ))}
        </ul>
      )}
    </div>
  );
}
