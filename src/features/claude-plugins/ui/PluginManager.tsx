import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "../../../shared/ui/icons";
import type { ClaudePlugin } from "../model/pluginCli";
import {
  addMarketplace,
  installPlugin,
  listAvailablePlugins,
  listMarketplaces,
  removeMarketplace,
  uninstallPlugin,
  updateMarketplace,
  updatePlugin,
} from "../model/pluginActions";
import {
  canManage,
  checkMarketplaceSource,
  type AvailablePlugin,
  type InstallScope,
  type ManageResult,
  type Marketplace,
  type ShownCommand,
} from "../model/pluginManage";

const NOTE = "text-[11px] leading-4 text-content/45";
const BUTTON =
  "h-7 shrink-0 rounded-md border border-content/10 px-2 text-[12px] text-content/75 hover:bg-content/10 hover:text-content disabled:opacity-40";
const DANGER =
  "h-7 shrink-0 rounded-md border border-red-400/30 px-2 text-[12px] text-red-400 hover:bg-red-400/10 disabled:opacity-40";
const FIELD =
  "h-7 min-w-0 rounded-md border border-content/10 bg-transparent px-2 text-[12px] text-content";

function ResultLine({ result }: { result: ManageResult | null }) {
  if (!result || result.ok === false) {
    return result ? (
      <p role="alert" className="text-[11px] leading-4 text-red-400">
        {result.message}
      </p>
    ) : null;
  }
  return result.message ? (
    <p className="text-[11px] leading-4 text-content/55">
      {result.message.split("\n")[0]}
    </p>
  ) : null;
}

/**
 * A command a marketplace declares, which Claude Code runs on this machine to
 * fetch a plugin. Nothing runs until Accept is pressed, and Accept passes the
 * command's own hash, so a command that changed in between is refused again.
 */
export function CommandConsent({
  shown,
  verb,
  busy,
  onAccept,
  onCancel,
}: {
  shown: ShownCommand;
  verb: "install" | "update";
  busy: boolean;
  onAccept: () => void;
  onCancel: () => void;
}) {
  const at = shown.pluginId.lastIndexOf("@");
  const marketplace = at > 0 ? shown.pluginId.slice(at + 1) : "its marketplace";
  return (
    <div
      role="alertdialog"
      aria-label="Command to run"
      data-plugin-consent={shown.sha256}
      className="flex flex-col gap-2 rounded-lg border border-amber-400/40 p-2.5"
    >
      <p className="text-[12px] text-content/80">
        To {verb} {shown.pluginId}, Claude Code runs this command from{" "}
        {marketplace} on this computer, with your full rights and outside any
        sandbox:
      </p>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-content/5 p-2 text-[11px] text-content">
        {shown.command}
      </pre>
      {shown.archiveUrl ? (
        <p className={NOTE}>It fetches {shown.archiveUrl}.</p>
      ) : null}
      <p className={NOTE}>
        Only accept a command you have read and trust. The marketplace's
        publisher wrote it, not Claude Code.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          className={DANGER}
          disabled={busy}
          onClick={onAccept}
        >
          Run it and {verb}
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Update and uninstall on one installed plugin's row. */
export function PluginRowActions({
  plugin,
  accountId,
}: {
  plugin: ClaudePlugin;
  accountId: string | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ManageResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleteData, setDeleteData] = useState(false);
  const [shown, setShown] = useState<ShownCommand | null>(null);
  if (!canManage(plugin)) return null;

  const run = async (task: () => Promise<ManageResult>) => {
    setBusy(true);
    const next = await task();
    setBusy(false);
    setResult(next);
    setShown(next.ok === false && next.shownCommand ? next.shownCommand : null);
    return next;
  };

  return (
    <div className="flex flex-col gap-1.5" data-plugin-actions={plugin.id}>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          className={BUTTON}
          disabled={busy}
          onClick={() => void run(() => updatePlugin(plugin, accountId))}
        >
          Update
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          Uninstall
        </button>
      </div>
      {confirming ? (
        <div
          role="alertdialog"
          aria-label={`Uninstall ${plugin.name}`}
          className="flex flex-col gap-1.5 rounded-lg border border-content/10 p-2"
        >
          <p className="text-[12px] text-content/75">
            Uninstall {plugin.name} from this scope? Chats load the change when
            they next start.
          </p>
          <label className="flex items-center gap-1.5 text-[11px] text-content/60">
            <input
              type="checkbox"
              checked={deleteData}
              onChange={(event) => setDeleteData(event.target.checked)}
            />
            Also delete its saved data
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              className={DANGER}
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                void run(() => uninstallPlugin(plugin, deleteData, accountId));
              }}
            >
              Uninstall
            </button>
            <button
              type="button"
              className={BUTTON}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {shown ? (
        <CommandConsent
          shown={shown}
          verb="update"
          busy={busy}
          onCancel={() => {
            setShown(null);
            setResult(null);
          }}
          onAccept={() =>
            void run(() => updatePlugin(plugin, accountId, shown.sha256))
          }
        />
      ) : (
        <ResultLine result={result} />
      )}
    </div>
  );
}

const SCOPE_CHOICES: { value: InstallScope; label: string }[] = [
  { value: "user", label: "For me (user settings)" },
  { value: "local", label: "This project, only me (settings.local.json)" },
  { value: "project", label: "This project, shared (settings.json)" },
];

/** Pick a plugin a marketplace offers and install it at a scope. */
export function InstallPluginForm({
  cwd,
  accountId,
}: {
  cwd: string | undefined;
  accountId: string | undefined;
}) {
  const [available, setAvailable] = useState<AvailablePlugin[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pick, setPick] = useState("");
  const [scope, setScope] = useState<InstallScope>("user");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ManageResult | null>(null);
  const [shown, setShown] = useState<ShownCommand | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const read = await listAvailablePlugins(accountId);
    if ("error" in read) {
      setAvailable(null);
      setListError(read.error);
      setLoading(false);
      return;
    }
    const list = read.plugins;
    setListError(null);
    setAvailable(list);
    setPick((current) =>
      list.some((entry) => entry.id === current)
        ? current
        : (list[0]?.id ?? ""),
    );
    setLoading(false);
  }, [accountId]);

  const install = async (acceptHash?: string) => {
    if (!pick) return;
    setBusy(true);
    const next = await installPlugin(pick, scope, cwd, accountId, acceptHash);
    setBusy(false);
    setResult(next);
    setShown(next.ok === false && next.shownCommand ? next.shownCommand : null);
    if (next.ok) void load();
  };

  const chosen = available?.find((entry) => entry.id === pick);
  return (
    <section
      aria-label="Install a plugin"
      className="flex flex-col gap-2"
      data-plugin-install
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex-1 text-[12px] font-medium text-content/75">
          Install a plugin
        </h3>
        <button
          type="button"
          className={BUTTON}
          disabled={loading}
          onClick={() => void load()}
        >
          {available ? "Read again" : "Browse marketplaces"}
        </button>
      </div>
      {listError ? (
        <p role="alert" className="text-[11px] leading-4 text-red-400">
          {listError}
        </p>
      ) : null}
      {available && available.length === 0 ? (
        <p className={NOTE}>
          The marketplaces below offer nothing that is not installed yet.
        </p>
      ) : null}
      {available && available.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Plugin to install"
            className={`${FIELD} flex-1`}
            value={pick}
            onChange={(event) => setPick(event.target.value)}
          >
            {available.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} · {entry.marketplace}
              </option>
            ))}
          </select>
          <select
            aria-label="Install for"
            className={FIELD}
            value={scope}
            onChange={(event) => setScope(event.target.value as InstallScope)}
          >
            {SCOPE_CHOICES.map((choice) => (
              <option
                key={choice.value}
                value={choice.value}
                disabled={choice.value !== "user" && !cwd}
              >
                {choice.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={BUTTON}
            disabled={busy || !pick || (scope !== "user" && !cwd)}
            onClick={() => void install()}
          >
            Install
          </button>
        </div>
      ) : null}
      {chosen?.description ? (
        <p className={NOTE}>{chosen.description}</p>
      ) : null}
      <p className={NOTE}>
        A plugin can add skills, hooks and MCP servers that run on this computer
        with your rights in every Claude Code chat it loads in.
      </p>
      {shown ? (
        <CommandConsent
          shown={shown}
          verb="install"
          busy={busy}
          onCancel={() => {
            setShown(null);
            setResult(null);
          }}
          onAccept={() => void install(shown.sha256)}
        />
      ) : (
        <ResultLine result={result} />
      )}
    </section>
  );
}

/** The account's marketplaces: list, add, update and remove. */
export function MarketplacesSection({
  accountId,
}: {
  accountId: string | undefined;
}) {
  const [list, setList] = useState<Marketplace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ManageResult | null>(null);
  const [source, setSource] = useState("");
  const [confirmAdd, setConfirmAdd] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await listMarketplaces(accountId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, task: () => Promise<ManageResult>) => {
    setBusy(key);
    const next = await task();
    setBusy(null);
    setResult(next);
    await load();
    return next;
  };

  const check = source.trim() ? checkMarketplaceSource(source) : null;
  return (
    <section
      aria-label="Marketplaces"
      className="flex flex-col gap-2"
      data-plugin-marketplaces
    >
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-[12px] font-medium text-content/75">
          Marketplaces
        </h3>
        <button
          type="button"
          aria-label="Refresh marketplaces"
          className="grid size-7 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content"
          onClick={() => void load()}
        >
          <RefreshCw className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-[12px] text-red-400">
          Could not list marketplaces: {error}
        </p>
      ) : null}
      {list && list.length === 0 ? (
        <p className={NOTE}>No marketplaces added.</p>
      ) : null}
      {list && list.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {list.map((entry) => (
            <li
              key={entry.name}
              data-marketplace={entry.name}
              className="flex min-w-0 flex-col gap-1 rounded-lg border border-content/10 p-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-content">
                    {entry.name}
                  </p>
                  <p
                    className="truncate text-[11px] text-content/45"
                    title={entry.origin}
                  >
                    {entry.source}
                    {entry.origin ? ` · ${entry.origin}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy !== null}
                  onClick={() =>
                    void run(entry.name, () =>
                      updateMarketplace(entry.name, accountId),
                    )
                  }
                >
                  Update
                </button>
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy !== null}
                  onClick={() => setRemoving(entry.name)}
                >
                  Remove
                </button>
              </div>
              {removing === entry.name ? (
                <div
                  role="alertdialog"
                  aria-label={`Remove ${entry.name}`}
                  className="flex flex-col gap-1.5"
                >
                  <p className="text-[12px] text-content/75">
                    Removing {entry.name} also uninstalls every plugin installed
                    from it and deletes their saved options, secrets and data.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className={DANGER}
                      onClick={() => {
                        setRemoving(null);
                        void run(entry.name, () =>
                          removeMarketplace(entry.name, accountId),
                        );
                      }}
                    >
                      Remove and uninstall
                    </button>
                    <button
                      type="button"
                      className={BUTTON}
                      onClick={() => setRemoving(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Marketplace source"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="owner/repo, https:// URL or /absolute/path"
          className={`${FIELD} flex-1`}
          value={source}
          onChange={(event) => {
            setSource(event.target.value);
            setConfirmAdd(false);
          }}
        />
        <button
          type="button"
          className={BUTTON}
          disabled={busy !== null || !check?.ok}
          onClick={() => setConfirmAdd(true)}
        >
          Add
        </button>
      </div>
      {check && !check.ok ? (
        <p className="text-[11px] leading-4 text-red-400">{check.reason}</p>
      ) : null}
      {confirmAdd && check?.ok ? (
        <div
          role="alertdialog"
          aria-label="Add marketplace"
          className="flex flex-col gap-1.5 rounded-lg border border-amber-400/40 p-2"
        >
          <p className="text-[12px] text-content/80">
            Add {source.trim()} to your Claude Code user settings? A marketplace
            is a list of plugins from whoever publishes it. Claude Code
            downloads it now. A plugin installed from it later runs its code on
            this computer, and any install command it declares is shown here
            before it runs.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className={DANGER}
              disabled={busy !== null}
              onClick={async () => {
                setConfirmAdd(false);
                const next = await run("add", () =>
                  addMarketplace(source.trim(), accountId),
                );
                if (next.ok) setSource("");
              }}
            >
              Add it
            </button>
            <button
              type="button"
              className={BUTTON}
              onClick={() => setConfirmAdd(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <ResultLine result={result} />
    </section>
  );
}
