import { useEffect, useMemo, useState } from "react";
import { ConnectorSwitch } from "../../session-tools/ui/ConnectorSwitch";
import {
  enableAllConnectorTools,
  readConnectorTools,
  setConnectorTool,
  smallestContextWindow,
  toolContextWarning,
  toolsAvailable,
  type ConnectorTools,
  type ToolsUnavailable,
} from "../model/connectorTools";
import {
  readToolLoading,
  saveToolLoading,
  TOOL_LOADING_CHOICES,
  type ToolLoading,
} from "../model/toolLoading";

const NOTE = "text-[11px] leading-4 text-content/45";

/**
 * The installed connector's tools, each with a switch. Off is "never": the
 * tool leaves the connector's Docker profile for every harness and chat.
 * "Ask" and "always" per tool are the per-chat tool access rules, on Claude
 * Code only, where approvals name the tool.
 */
export function ConnectorToolsSection({
  profileId,
  server,
}: {
  profileId: string;
  server: string;
}) {
  const [state, setState] = useState<ConnectorTools | ToolsUnavailable | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void readConnectorTools(profileId, server).then((value) => {
      if (live) setState(value);
    });
    return () => {
      live = false;
    };
  }, [profileId, server]);

  const smallest = useMemo(() => smallestContextWindow(), []);
  if (!state) {
    return (
      <section aria-label="Tools">
        <p className={NOTE}>Reading this connector's tools from Docker…</p>
      </section>
    );
  }
  if (!toolsAvailable(state)) {
    return (
      <section aria-label="Tools" data-connector-tools="unavailable">
        <p className={NOTE}>{state.reason}</p>
      </section>
    );
  }

  const apply = async (
    key: string,
    task: () => ReturnType<typeof setConnectorTool>,
  ) => {
    setBusy(key);
    setError(null);
    const result = await task();
    setBusy(null);
    if (result.ok) setState(result.tools);
    else {
      setError(result.reason);
      if (result.tools) setState(result.tools);
    }
  };

  const warning = toolContextWarning(state.onCount, smallest);
  return (
    <section
      aria-label="Tools"
      className="flex flex-col gap-1.5"
      data-connector-tools={state.onCount}
    >
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-[12px] text-content/55">
          {state.allOn
            ? `All ${state.tools.length} ${state.tools.length === 1 ? "tool" : "tools"} on`
            : `${state.onCount} of ${state.tools.length} tools on`}
        </p>
        {!state.allOn ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void apply("all", () =>
                enableAllConnectorTools(profileId, server),
              )
            }
            className="rounded-md border border-content/10 px-2 py-0.5 text-[12px] text-content/75 hover:bg-content/10 disabled:opacity-40"
          >
            Turn all on
          </button>
        ) : null}
      </div>
      <p className={NOTE}>
        A tool turned off here is never offered, in any chat or harness that
        uses this connector, and its definition stops costing context.
      </p>
      {warning ? (
        <p role="note" className="text-[11px] leading-4 text-amber-400">
          {warning}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[11px] leading-4 text-red-400">
          {error}
        </p>
      ) : null}
      <ul className="flex max-h-64 flex-col gap-1 overflow-auto">
        {state.tools.map((tool) => (
          <li
            key={tool.name}
            data-tool={tool.name}
            data-tool-state={tool.on ? "on" : "off"}
            className="flex min-w-0 items-center gap-2"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[11px] text-content/75">
                {tool.name}
              </p>
              {tool.description ? (
                <p
                  className="truncate text-[11px] text-content/40"
                  title={tool.description}
                >
                  {tool.description}
                </p>
              ) : null}
            </div>
            {tool.switchable ? (
              <ConnectorSwitch
                label={tool.name}
                on={tool.on}
                disabled={busy !== null}
                onChange={(on) =>
                  void apply(tool.name, () =>
                    setConnectorTool(profileId, server, tool.name, on),
                  )
                }
              />
            ) : (
              <span className={NOTE}>Cannot be switched from here</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** How Claude Code loads connector tool definitions, for every new chat. */
export function ToolLoadingSetting() {
  const [value, setValue] = useState<ToolLoading>(() => readToolLoading());
  const choice = TOOL_LOADING_CHOICES.find((entry) => entry.value === value);
  return (
    <section
      aria-label="Claude Code tool loading"
      className="flex flex-col gap-1"
      data-tool-loading={value}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor="claude-tool-loading"
          className="min-w-0 flex-1 text-[12px] text-content/75"
        >
          Claude Code: load connector tools
        </label>
        <select
          id="claude-tool-loading"
          value={value}
          onChange={(event) => {
            const next = event.target.value as ToolLoading;
            saveToolLoading(next);
            setValue(next);
          }}
          className="h-7 rounded-md border border-content/10 bg-transparent px-2 text-[12px] text-content"
        >
          {TOOL_LOADING_CHOICES.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>
      <p className={NOTE}>
        {choice?.note} A Claude Code chat picks the change up on its next turn,
        which restarts its process. Other harnesses load every tool of every
        connector that is on.
      </p>
    </section>
  );
}
