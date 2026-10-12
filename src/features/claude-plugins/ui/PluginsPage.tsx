import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "../../../shared/ui/icons";
import { ConnectorSwitch } from "../../session-tools/ui/ConnectorSwitch";
import {
  providerAccounts,
  selectedProviderAccountId,
} from "../../providers/model/providerAccounts";
import {
  folderName,
  pluginControl,
  pluginRowKey,
  scopeLabel,
  type ClaudePlugin,
} from "../model/pluginCli";
import {
  contentsSummary,
  readPluginContents,
  refreshPlugins,
  setPluginEnabled,
  useClaudePlugins,
  type PluginContents,
} from "../model/plugins";
import {
  InstallPluginForm,
  MarketplacesSection,
  PluginRowActions,
} from "./PluginManager";

const NOTE = "text-[11px] leading-4 text-content/45";

/** The order rows are listed in: yours first, then projects, then the rest. */
const SCOPE_ORDER: Record<ClaudePlugin["scope"], number> = {
  user: 0,
  synced: 1,
  local: 2,
  project: 3,
  managed: 4,
  session: 5,
};

/** Why a scope's switch writes where it does, for the row's tooltip. */
function scopeTitle(plugin: ClaudePlugin): string {
  switch (plugin.scope) {
    case "user":
      return "Saved in your Claude Code user settings";
    case "synced":
      return "From your claude.ai account. The switch saves your choice in your Claude Code user settings";
    case "local":
      return `Saved in .claude/settings.local.json in ${plugin.projectPath ?? "the project"}`;
    case "project":
      return `Saved in .claude/settings.json in ${plugin.projectPath ?? "the project"}, which is shared with the project`;
    case "managed":
      return "Set by your organization";
    case "session":
      return "Loaded for one session only";
  }
}

function PluginRow({
  plugin,
  pending,
  error,
  onToggle,
  accountId,
}: {
  plugin: ClaudePlugin;
  pending: boolean;
  error?: string;
  onToggle: (on: boolean) => void;
  accountId?: string;
}) {
  const [found, setFound] = useState<PluginContents | null>(null);
  useEffect(() => {
    let live = true;
    void readPluginContents(plugin.installPath).then((value) => {
      if (live) setFound(value);
    });
    return () => {
      live = false;
    };
  }, [plugin.installPath]);
  const control = pluginControl(plugin);
  const brings = contentsSummary(plugin, found);
  const where =
    (plugin.scope === "local" || plugin.scope === "project") &&
    plugin.projectPath
      ? `Only in ${folderName(plugin.projectPath)}`
      : null;
  return (
    <li
      className="flex min-w-0 items-start gap-3 rounded-lg border border-content/10 p-2.5"
      data-plugin-row={plugin.id}
      data-plugin-scope={plugin.scope}
      data-plugin-state={plugin.enabled ? "on" : "off"}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13px] text-content" title={plugin.id}>
            {plugin.name}
          </span>
          <span className="shrink-0 text-[11px] text-content/35">
            {plugin.version}
          </span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px] text-content/50">
          {plugin.marketplace && plugin.scope !== "synced" ? (
            <span className="truncate">{plugin.marketplace}</span>
          ) : null}
          <span
            className="shrink-0 rounded border border-content/10 px-1 text-[11px] leading-4 text-content/55"
            title={scopeTitle(plugin)}
          >
            {scopeLabel(plugin.scope)}
          </span>
          {where ? (
            <span className="truncate" title={plugin.projectPath}>
              {where}
            </span>
          ) : null}
        </div>
        {brings ? (
          <p className="truncate text-[11px] text-content/45" title={brings}>
            {brings}
          </p>
        ) : null}
        {plugin.errors.map((entry) => (
          <p key={entry} className="text-[11px] leading-4 text-red-400/80">
            {entry}
          </p>
        ))}
        {control.kind === "read-only" ? (
          <p className={NOTE}>{control.reason}</p>
        ) : null}
        {error ? (
          <p role="alert" className="text-[11px] leading-4 text-red-400">
            {error}
          </p>
        ) : null}
        <PluginRowActions plugin={plugin} accountId={accountId} />
      </div>
      {control.kind === "switch" ? (
        <ConnectorSwitch
          label={`${plugin.name} (${scopeLabel(plugin.scope)})`}
          on={plugin.enabled}
          disabled={pending}
          onChange={onToggle}
        />
      ) : null}
    </li>
  );
}

/**
 * Every Claude Code plugin the chosen account has installed, from
 * `claude plugin list --json`, with a switch that runs `claude plugin enable`
 * or `disable` at the plugin's own scope. Claude Code only: other harnesses
 * have no plugins MonoCode can read.
 */
export function PluginsPage({ cwd }: { cwd: string }) {
  const accounts = useMemo(() => providerAccounts("claude"), []);
  const [accountId, setAccountId] = useState(() =>
    selectedProviderAccountId("claude", cwd),
  );
  const state = useClaudePlugins(accountId);
  const plugins = useMemo(
    () =>
      [...(state.plugins ?? [])].sort(
        (a, b) =>
          SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] ||
          a.name.localeCompare(b.name) ||
          (a.projectPath ?? "").localeCompare(b.projectPath ?? ""),
      ),
    [state.plugins],
  );
  const hasSynced = plugins.some((plugin) => plugin.scope === "synced");
  return (
    <div className="flex flex-col gap-3" data-plugins-page>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-40 flex-1 text-[12px] text-content/50">
          Turning a plugin on or off here changes Claude Code's settings for
          every chat. New chats load the change; running ones load it when they
          next start.
        </p>
        {accounts.length > 1 ? (
          <select
            aria-label="Claude Code account"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            className="h-7 rounded-md border border-content/10 bg-transparent px-2 text-[12px] text-content"
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          aria-label="Refresh plugins"
          title="Ask Claude Code again"
          disabled={state.loading}
          onClick={() => void refreshPlugins(accountId)}
          className="grid size-7 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content disabled:opacity-40"
        >
          <RefreshCw className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>

      {state.error ? (
        <p role="alert" className="text-[12px] text-red-400">
          Could not list Claude Code plugins: {state.error}
        </p>
      ) : null}

      {!state.plugins ? (
        state.loading ? (
          <p className="text-[12px] text-content/45">
            Asking Claude Code for its plugins…
          </p>
        ) : null
      ) : plugins.length === 0 ? (
        <p className="text-[12px] text-content/45">
          No plugins installed. Install one below, or with /plugin in Claude
          Code.
        </p>
      ) : (
        <ul aria-label="Claude Code plugins" className="flex flex-col gap-2">
          {plugins.map((plugin) => {
            const key = pluginRowKey(plugin);
            return (
              <PluginRow
                key={key}
                plugin={plugin}
                pending={state.pending.includes(key)}
                error={state.rowErrors[key]}
                onToggle={(on) => void setPluginEnabled(plugin, on, accountId)}
                accountId={accountId}
              />
            );
          })}
        </ul>
      )}
      <InstallPluginForm cwd={cwd || undefined} accountId={accountId} />
      <MarketplacesSection accountId={accountId} />
      {hasSynced ? (
        <p className={NOTE}>
          claude.ai plugins come from your claude.ai account. Turning one off
          here keeps it off in Claude Code only. A plugin your organization
          requires cannot be turned off.
        </p>
      ) : null}
    </div>
  );
}
