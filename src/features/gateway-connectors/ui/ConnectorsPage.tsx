import { useEffect, useMemo, useRef, useState } from "react";
import { ToolLoadingSetting } from "./ConnectorTools";
import { RefreshCw, Search } from "../../../shared/ui/icons";
import { getCachedMcpSettings } from "../../settings/model/mcpSettingsCache";
import { knownReportedMcpServerNames } from "../../session-tools/model/reportedMcpServers";
import {
  HIDDEN_FROM_DISCOVER,
  loadCatalog,
  useCatalog,
  type CatalogConnector,
} from "../model/catalog";
import {
  addAndStart,
  cancelSignIn,
  dockerStateMessage,
  refreshInstalled,
  removeConnector,
  saveSetupAndTest,
  signInAndTest,
  signOutConnector,
  TEST_FRESH_MS,
  testConnector,
  testStale,
  useInstalledConnectors,
  type InstalledConnector,
} from "../model/installed";
import {
  onConnectorsTabRequest,
  takeRequestedConnectorsTab,
  type ConnectorsTab,
} from "../model/navigation";
import { ConnectorCard } from "./ConnectorCard";
import { ConnectorDetail, type ConnectorActions } from "./ConnectorDetail";

type KindFilter = "all" | "remote" | "container";

const KIND_FILTERS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "remote", label: "Hosted" },
  { value: "container", label: "Runs in Docker" },
];

/** A catalog-shaped entry for an added connector the catalog does not list. */
function entryOf(connector: InstalledConnector): CatalogConnector {
  return {
    name: connector.server,
    title: connector.title,
    description: connector.description,
    ...(connector.icon ? { icon: connector.icon } : {}),
    kind: connector.kind,
    auth: connector.auth,
    secrets: connector.secrets,
    oauthProviders: connector.oauthApp ? [connector.oauthApp] : [],
    settings: connector.settings,
    tags: [],
    tools: [],
  };
}

function matches(entry: CatalogConnector, needle: string): boolean {
  if (!needle) return true;
  return [entry.title, entry.name, entry.description, entry.category ?? ""]
    .concat(entry.tags)
    .some((text) => text.toLowerCase().includes(needle));
}

/**
 * MonoCode's connectors marketplace, backed by Docker's MCP gateway. Discover
 * lists Docker's catalog; Yours lists what was added, with what each still
 * needs. A connector added and signed in here is started in every Claude
 * Code and Codex chat, so no harness needs its own sign-in.
 */
export function ConnectorsPage({ cwd }: { cwd: string }) {
  const catalog = useCatalog();
  const installed = useInstalledConnectors();
  const [tab, setTab] = useState<ConnectorsTab>(
    () =>
      takeRequestedConnectorsTab() ??
      (installed.connectors.length > 0 ? "yours" : "discover"),
  );
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [open, setOpen] = useState<string | null>(null);
  // Opened right after adding, on its setup form.
  const [openOnSetup, setOpenOnSetup] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => onConnectorsTabRequest(setTab), []);
  useEffect(() => {
    void loadCatalog();
    void refreshInstalled();
  }, []);
  // Yours tests what was never tested or not in the last day.
  useEffect(() => {
    if (tab !== "yours" || installed.dockerState !== "ready") return;
    void testStale({ maxAgeMs: TEST_FRESH_MS });
  }, [installed.dockerState, tab]);

  const byServer = useMemo(
    () => new Map(installed.connectors.map((c) => [c.server, c])),
    [installed.connectors],
  );
  const catalogByName = useMemo(
    () => new Map((catalog.connectors ?? []).map((e) => [e.name, e])),
    [catalog.connectors],
  );
  const needle = query.trim().toLowerCase();
  const discover = useMemo(
    () =>
      (catalog.connectors ?? []).filter(
        (entry) =>
          !HIDDEN_FROM_DISCOVER.has(entry.name) &&
          (kind === "all" || entry.kind === kind) &&
          matches(entry, needle),
      ),
    [catalog.connectors, kind, needle],
  );
  const yours = useMemo(
    () =>
      installed.connectors
        .map((connector) => ({
          connector,
          entry: catalogByName.get(connector.server) ?? entryOf(connector),
        }))
        .filter(({ entry }) => matches(entry, needle)),
    [catalogByName, installed.connectors, needle],
  );

  const report = (err: unknown) =>
    setError(err instanceof Error ? err.message : String(err));
  const add = async (entry: CatalogConnector) => {
    // A name a harness already uses gets `-gateway` added, so the gateway
    // copy never replaces the user's own server.
    const taken = new Set([
      ...knownReportedMcpServerNames(),
      ...(getCachedMcpSettings(cwd)?.servers.map((server) => server.name) ??
        []),
    ]);
    const next = await addAndStart(entry, taken, report);
    // Keys and settings are asked for straight away, as the Claude app does.
    if (next === "setup") {
      setOpenOnSetup(true);
      setOpen(entry.name);
    }
  };
  const actions: ConnectorActions = {
    add,
    remove: (connector, options) => removeConnector(connector, options),
    saveSetup: saveSetupAndTest,
    signIn: signInAndTest,
    cancelSignIn: (connector) => cancelSignIn(connector.profileId),
    signOut: signOutConnector,
    test: testConnector,
  };
  const cardHandlers = (entry: CatalogConnector) => {
    const connector = byServer.get(entry.name);
    return {
      connector,
      testing: !!connector && installed.testing.includes(connector.profileId),
      signingIn:
        !!connector && installed.signingIn.includes(connector.profileId),
      onOpen: () => openDetail(entry.name),
      onAdd: () => quickAdd(entry),
      onSignIn: () => {
        if (connector) void signInAndTest(connector).catch(report);
      },
      onSetUp: () => openDetail(entry.name, true),
      onTest: () => {
        if (connector) void testConnector(connector);
      },
      onCancelSignIn: () => {
        if (connector) cancelSignIn(connector.profileId);
      },
    };
  };

  const quickAdd = (entry: CatalogConnector) => {
    setAdding(entry.name);
    setError(null);
    void add(entry)
      .catch(report)
      .finally(() => setAdding(null));
  };

  const openDetail = (name: string, setup = false) => {
    setOpenOnSetup(setup);
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setOpen(name);
  };
  const closeDetail = () => {
    setOpen(null);
    const target = opener.current;
    opener.current = null;
    if (target?.isConnected) requestAnimationFrame(() => target.focus());
  };

  const openEntry = open
    ? (catalogByName.get(open) ??
      (byServer.get(open) ? entryOf(byServer.get(open)!) : undefined))
    : undefined;
  const dockerMessage = dockerStateMessage(
    installed.dockerState,
    installed.error,
  );
  const loading =
    tab === "discover" ? catalog.loading && !catalog.connectors : false;

  return (
    <div className="flex flex-col gap-3" data-connectors-page>
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="radiogroup"
          aria-label="Connectors view"
          className="inline-grid shrink-0 grid-cols-2 gap-0.5 rounded-md border border-content/10 p-0.5 text-[12px]"
        >
          {(
            [
              ["yours", "Yours"],
              ["discover", "Discover"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={tab === value}
              onClick={() => setTab(value)}
              className={`min-w-0 rounded-[5px] px-3 py-1 ${
                tab === value
                  ? "bg-selection text-content"
                  : "text-content/50 hover:text-content"
              }`}
            >
              {label}
              {value === "yours" && installed.connectors.length > 0
                ? ` ${installed.connectors.length}`
                : ""}
            </button>
          ))}
        </div>
        <label className="flex h-7 min-w-40 flex-1 items-center gap-2 rounded-md border border-content/10 px-2 text-content/45 focus-within:border-content/20">
          <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search connectors"
            aria-label="Search connectors"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/35"
          />
        </label>
        <button
          type="button"
          aria-label="Refresh connectors"
          title={
            tab === "discover"
              ? "Pull the latest catalog from Docker"
              : "Ask Docker again"
          }
          disabled={catalog.loading || installed.loading}
          onClick={() => {
            if (tab === "discover") void loadCatalog({ force: true });
            void refreshInstalled();
          }}
          className="grid size-7 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content disabled:opacity-40"
        >
          <RefreshCw className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>

      {tab === "discover" ? (
        <div
          role="radiogroup"
          aria-label="Where it runs"
          className="flex flex-wrap gap-1.5"
        >
          {KIND_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              role="radio"
              aria-checked={kind === filter.value}
              onClick={() => setKind(filter.value)}
              className={`rounded-full border px-2.5 py-0.5 text-[12px] ${
                kind === filter.value
                  ? "border-content/25 bg-content/10 text-content"
                  : "border-content/10 text-content/55 hover:text-content"
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>
      ) : null}

      {dockerMessage ? (
        <p
          role="alert"
          className="rounded-lg border border-content/10 bg-content/[0.03] px-3 py-2 text-[12px] text-content/70"
        >
          {dockerMessage}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[12px] text-red-400">
          {error}
        </p>
      ) : null}

      {tab === "discover" ? (
        catalog.error && !catalog.connectors ? (
          <p role="alert" className="text-[12px] text-red-400">
            Could not read Docker's MCP catalog: {catalog.error}
          </p>
        ) : loading ? (
          <p className="text-[12px] text-content/45">
            Reading Docker's MCP catalog…
          </p>
        ) : discover.length === 0 ? (
          <p className="text-[12px] text-content/45">No matching connectors</p>
        ) : (
          <ul
            aria-label="Docker MCP catalog"
            className="grid grid-cols-1 gap-2 @min-[640px]/settings:grid-cols-2"
            data-connector-grid
          >
            {discover.map((entry) => (
              <ConnectorCard
                key={entry.name}
                entry={entry}
                busy={adding === entry.name}
                {...cardHandlers(entry)}
              />
            ))}
          </ul>
        )
      ) : yours.length === 0 ? (
        <p className="text-[12px] text-content/45">
          {installed.connectors.length === 0
            ? "No connectors yet. Add one from Discover."
            : "No matching connectors"}
        </p>
      ) : (
        <ul
          aria-label="Your connectors"
          className="grid grid-cols-1 gap-2 @min-[640px]/settings:grid-cols-2"
          data-connector-grid
        >
          {yours.map(({ connector, entry }) => (
            <ConnectorCard
              key={connector.profileId}
              entry={entry}
              {...cardHandlers(entry)}
            />
          ))}
        </ul>
      )}

      <ToolLoadingSetting />
      <p className="pt-1 text-[12px] leading-relaxed text-content/40">
        Connectors run through Docker's MCP gateway, so Docker Desktop must be
        running. Each one is tested with a gateway dry run. Only connectors
        whose last test passed start in Claude Code and Codex chats, from the
        next turn; switch one off per chat from the composer's connectors list.
      </p>
      <p className="text-[12px] text-content/40">
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(new Event("monocode:open-mcp-settings"))
          }
          className="underline decoration-content/25 underline-offset-2 hover:text-content"
        >
          MCP servers configured in each harness
        </button>
      </p>

      {open && openEntry ? (
        <ConnectorDetail
          entry={openEntry}
          connector={byServer.get(open)}
          config={
            byServer.get(open)
              ? installed.config[byServer.get(open)!.profileId]
              : undefined
          }
          testing={
            !!byServer.get(open) &&
            installed.testing.includes(byServer.get(open)!.profileId)
          }
          signingIn={
            !!byServer.get(open) &&
            installed.signingIn.includes(byServer.get(open)!.profileId)
          }
          focusSetup={openOnSetup}
          actions={actions}
          onClose={closeDetail}
        />
      ) : null}
    </div>
  );
}
