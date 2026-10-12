import { useCallback, useEffect, useRef, useState } from "react";
import {
  canListHarnessMcpServers,
  listHarnessMcpServers,
} from "../../../integrations/harness/core/registry";
import type { HarnessMcpServer } from "../../../integrations/harness/core/types";
import { Plus, RefreshCw, Settings } from "../../../shared/ui/icons";
import {
  Popover,
  type PopoverAnchor,
  type PopoverDismissReason,
} from "../../../shared/ui/Popover";
import { HARNESS_TITLE, type HarnessId } from "../../sessions/model/session";
import {
  getCachedMcpSettings,
  loadMcpSettings,
  subscribeMcpSettings,
  type McpSettingsSnapshot,
} from "../../settings/model/mcpSettingsCache";
import {
  connectorChangePending,
  connectorRows,
  connectorSwitchCaveat,
  reportedConnectorRows,
  setMcpServerEnabled,
  withReportedConnectorRows,
} from "../model/connectors";
import { useReportedMcpServers } from "../model/reportedMcpServers";
import { noteHarnessServers } from "../../server-locality/model/sessionServers";
import { ServerLocalityTag } from "../../server-locality/ui/ServerLocalityTag";
import type { LocalityServer } from "../../server-locality/model/serverLocality";
import {
  loadClaudeConnectors,
  loadingClaudeConnectors,
} from "../model/claudeConnectors";
import { ConnectorSwitch } from "./ConnectorSwitch";
import {
  edgeFadeMask,
  useScrollEdges,
} from "../../session-panel/ui/useScrollEdges";
import type { ConnectorRow } from "../model/connectors";
import {
  claudeAiDuplicateToggle,
  GATEWAY_GROUP_TITLE,
  withGatewayRows,
} from "../../gateway-connectors/model/connectorRows";
import {
  refreshInstalled,
  useInstalledConnectors,
} from "../../gateway-connectors/model/installed";
import { openConnectorsPage } from "../../gateway-connectors/model/navigation";
import {
  gatewaySessionInput,
  harnessTakesGatewayConnectors,
  setClaudeAiExplicitlyOn,
  useExplicitlyOnClaudeAi,
} from "../../gateway-connectors/model/sessionGateway";
import { knownReportedMcpServerNames } from "../model/reportedMcpServers";

type RowGroup = { title: string; rows: ConnectorRow[]; prefix?: string };

/**
 * Rows under a heading each: servers from this computer's config files, the
 * Docker gateway's connectors, the claude.ai account's connectors, then
 * plugin servers. Headings show only when there is more than one group.
 */
function groupRows(
  rows: readonly ConnectorRow[],
  gatewayNames: ReadonlySet<string>,
): RowGroup[] {
  const local: ConnectorRow[] = [];
  const gateway: ConnectorRow[] = [];
  const account: ConnectorRow[] = [];
  const plugins: ConnectorRow[] = [];
  for (const row of rows) {
    if (gatewayNames.has(row.name)) gateway.push(row);
    else if (row.name.startsWith("claude.ai ")) account.push(row);
    else if (row.name.startsWith("plugin:")) plugins.push(row);
    else local.push(row);
  }
  return [
    { title: "This computer", rows: local },
    { title: GATEWAY_GROUP_TITLE, rows: gateway },
    { title: "claude.ai", rows: account, prefix: "claude.ai " },
    { title: "Plugins", rows: plugins, prefix: "plugin:" },
  ].filter((group) => group.rows.length > 0);
}

/** A row's name under its group's heading, without the repeated prefix. */
function shownName(name: string, prefix?: string): string {
  return prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

const ACTION =
  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content/65 hover:bg-content/10 hover:text-content";

/** What the session's own harness says it has, once it has answered. */
type Reported = { servers?: HarnessMcpServer[]; failed?: boolean };

const NO_ANSWER: Reported = {};

/**
 * The last answer per harness, account and directory. The popover unmounts
 * when it closes, and this lets it reopen on the rows it last showed instead
 * of an empty list while the harness is asked again.
 */
const answers = new Map<string, HarnessMcpServer[]>();

function lastAnswer(target: string): Reported {
  const servers = answers.get(target);
  return servers ? { servers } : NO_ANSWER;
}

/**
 * The MCP servers configured for the session's harness, each with a switch
 * for this chat. Switching one off never edits the harness's configuration.
 *
 * Codex is asked for its servers itself: a session's Codex can be a wrapper
 * binary or a provider account with its own home, which the app's discovery
 * does not read. Discovery stands in only when Codex cannot be asked.
 */
export function ConnectorsPopover({
  anchor,
  harness,
  sessionId,
  cwd,
  providerAccountId,
  disabled,
  atTurnStart,
  onChange,
  onManage,
  onDismiss,
}: {
  anchor: PopoverAnchor;
  harness: HarnessId;
  /**
   * The chat, so Claude Code's own report of what it loaded can add the
   * servers no config file names (claude.ai connectors, plugins).
   */
  sessionId?: string;
  /** Directory the session works in; MCP discovery runs there too. */
  cwd: string;
  /** Provider account the session runs under. */
  providerAccountId?: string;
  /** Server names switched off for this chat. */
  disabled: string[];
  /** `disabled` as the running turn started, or null while idle. */
  atTurnStart: readonly string[] | null;
  onChange: (disabled: string[]) => void;
  /**
   * Open Settings → MCP. Used only where the Docker gateway does not serve
   * the harness; elsewhere both actions open the Connectors page.
   */
  onManage: () => void;
  onDismiss: (reason: PopoverDismissReason) => void;
}) {
  const reports = canListHarnessMcpServers(harness);
  const target = `${harness}\n${providerAccountId ?? ""}\n${cwd}`;
  const [reported, setReported] = useState<Reported>(() => lastAnswer(target));
  const [asking, setAsking] = useState(reports);
  const request = useRef(0);
  const ask = useCallback(
    (refresh: boolean) => {
      const current = ++request.current;
      setAsking(true);
      const settle = (servers?: HarnessMcpServer[]) => {
        if (servers) answers.set(target, servers);
        else answers.delete(target);
        // #9: what the harness reported decides whether the session is local.
        noteHarnessServers(harness, providerAccountId, cwd, servers);
        if (request.current !== current) return;
        setReported(servers ? { servers } : { failed: true });
        setAsking(false);
      };
      listHarnessMcpServers(harness, { cwd, providerAccountId, refresh }).then(
        settle,
        () => settle(),
      );
    },
    [cwd, harness, providerAccountId, target],
  );
  useEffect(() => {
    if (!reports) return;
    // The last answer stays up while the harness is asked again.
    setReported(lastAnswer(target));
    ask(false);
    return () => {
      request.current += 1;
    };
  }, [ask, reports, target]);

  const answer = reports ? reported : NO_ANSWER;
  const discovers = !reports || answer.failed === true;
  const [snapshot, setSnapshot] = useState<McpSettingsSnapshot | undefined>(
    () => getCachedMcpSettings(cwd),
  );
  useEffect(() => {
    if (!discovers) return;
    setSnapshot(getCachedMcpSettings(cwd));
    const stop = subscribeMcpSettings(cwd, setSnapshot);
    void loadMcpSettings(cwd, false, { claudeHealth: harness === "claude" });
    return stop;
  }, [cwd, discovers, harness]);

  const discovered = discovers ? snapshot : undefined;
  // Until an answer arrives, every switched-off name would look unconfigured.
  const fileRows = answer.servers
    ? reportedConnectorRows(answer.servers, harness, disabled)
    : discovered
      ? connectorRows(discovered.servers, harness, disabled)
      : [];
  const fromClaude = useReportedMcpServers(
    sessionId,
    providerAccountId,
    harness === "claude",
  );
  // Claude Code is asked for the account's servers, claude.ai connectors and
  // plugins included, when the switches open (at most every few minutes).
  const [askingClaude, setAskingClaude] = useState(
    () => harness === "claude" && loadingClaudeConnectors(providerAccountId),
  );
  useEffect(() => {
    if (harness !== "claude") return;
    let live = true;
    setAskingClaude(true);
    void loadClaudeConnectors({ cwd, providerAccountId }).finally(() => {
      if (live) setAskingClaude(false);
    });
    return () => {
      live = false;
    };
  }, [cwd, harness, providerAccountId]);
  const harnessRows =
    harness === "claude"
      ? withReportedConnectorRows(fileRows, fromClaude, disabled)
      : fileRows;
  // Docker gateway connectors MonoCode adds at launch, asked for again when
  // the switches open.
  const takesGateway = harnessTakesGatewayConnectors(harness);
  const installed = useInstalledConnectors();
  useEffect(() => {
    if (takesGateway) void refreshInstalled();
  }, [takesGateway]);
  const explicitlyOn = useExplicitlyOnClaudeAi(sessionId);
  const defaultOff = gatewaySessionInput(
    { id: sessionId, harness, disabledMcpServers: disabled },
    cwd,
    installed,
  ).defaultOff;
  // `explicitlyOn` is read inside `gatewaySessionInput`; naming it here
  // re-renders the rows when a chat switches a claude.ai copy back on.
  void explicitlyOn;
  const { rows, gatewayNames } = withGatewayRows(harnessRows, {
    harness,
    installed,
    disabled,
    defaultOff,
  });
  const onToggle = (name: string, on: boolean) => {
    const duplicate = sessionId
      ? claudeAiDuplicateToggle({
          name,
          on,
          harness,
          installed,
          reportedNames: knownReportedMcpServerNames(),
          disabled,
        })
      : null;
    if (duplicate && sessionId) {
      setClaudeAiExplicitlyOn(sessionId, name, duplicate.explicitlyOn);
      const next = setMcpServerEnabled(disabled, name, !duplicate.listOff);
      if (next !== disabled) onChange(next);
      return;
    }
    onChange(setMcpServerEnabled(disabled, name, on));
  };
  // Both open MonoCode's Connectors page; closing the popover the way an
  // outside click does keeps focus where the page puts it.
  const openConnectors = (tab: "yours" | "discover") => {
    openConnectorsPage(tab);
    onDismiss("outside");
  };
  const checking = !answer.servers && !discovered;
  // #9: what each row's locality is decided from. Reported servers carry
  // their command or address; gateway rows are Docker gateway entries.
  const localityServer = (name: string): LocalityServer => {
    const reportedServer = answer.servers?.find((server) => server.name === name);
    if (reportedServer) {
      return {
        name,
        ...(reportedServer.command ? { command: reportedServer.command } : {}),
        ...(reportedServer.url ? { url: reportedServer.url } : {}),
      };
    }
    if (gatewayNames.has(name)) {
      return { name, command: "docker", args: ["mcp", "gateway", "run"] };
    }
    return { name };
  };
  const title = HARNESS_TITLE[harness];
  const caveat = connectorSwitchCaveat(harness);
  return (
    <Popover
      anchor={anchor}
      side="top"
      align="start"
      width={320}
      maxHeight={600}
      onDismiss={onDismiss}
      // The badge toggles this popover itself.
      ignore="[data-connectors-badge]"
      data-composer-plus
      role="dialog"
      aria-label="Connectors"
      className="p-1.5"
    >
      <div className="flex items-center justify-between px-2 pb-1 pt-0.5">
        <p className="text-[10px] font-medium uppercase tracking-wide text-content/40">
          Connectors
        </p>
        {reports ? (
          <button
            type="button"
            title={`Ask ${title} for its MCP servers again`}
            aria-label="Refresh connectors"
            disabled={asking}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => ask(true)}
            className="grid size-4 place-items-center rounded text-content/40 hover:text-content disabled:opacity-40"
          >
            <RefreshCw className="size-3" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
      {discovered?.error ? (
        <p role="alert" className="px-2 py-2 text-[12px] text-red-400">
          {discovered.error}
        </p>
      ) : null}
      {answer.failed ? (
        <p className="px-2 pb-1 text-[11px] leading-4 text-content/45">
          Default {title} config; may not match this chat.
        </p>
      ) : null}
      {rows.length > 0 ? (
        <ConnectorList
          title={title}
          rows={rows}
          gatewayNames={gatewayNames}
          onToggle={onToggle}
          localityServer={localityServer}
        />
      ) : discovered?.error ? null : (
        <p className="px-2 py-2 text-[12px] text-content/50">
          {checking
            ? "Checking MCP servers…"
            : `No MCP servers configured for ${title}`}
        </p>
      )}
      {harness === "claude" && !fromClaude && !checking ? (
        <p className="px-2 pb-0.5 pt-1 text-[11px] leading-4 text-content/45">
          {askingClaude
            ? "Checking claude.ai connectors and plugins…"
            : "Could not list claude.ai connectors and plugins."}
        </p>
      ) : null}
      {connectorChangePending(disabled, atTurnStart) ? (
        <p className="px-2 pb-0.5 pt-1 text-[11px] leading-4 text-content/45">
          Changes apply from the next turn.
        </p>
      ) : null}
      {caveat && rows.some((row) => !row.enabled && !row.configDisabled) ? (
        <p className="px-2 pb-0.5 pt-1 text-[11px] leading-4 text-content/45">
          {caveat}
        </p>
      ) : null}
      <div className="mt-1 border-t border-content/10 pt-1">
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={takesGateway ? () => openConnectors("discover") : onManage}
          className={ACTION}
        >
          <Plus className="size-3.5 shrink-0" />
          Add connector
        </button>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={takesGateway ? () => openConnectors("yours") : onManage}
          className={ACTION}
        >
          <Settings className="size-3.5 shrink-0" />
          Manage connectors
        </button>
      </div>
    </Popover>
  );
}

function ConnectorList({
  title,
  rows,
  gatewayNames,
  onToggle,
  localityServer,
}: {
  title: string;
  rows: ConnectorRow[];
  gatewayNames: ReadonlySet<string>;
  onToggle: (name: string, on: boolean) => void;
  localityServer?: (name: string) => LocalityServer;
}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const edges = useScrollEdges(scroller, rows.length);
  const groups = groupRows(rows, gatewayNames);
  const headed = groups.length > 1;
  return (
    <div
      ref={setScroller}
      data-connector-list
      className="max-h-[min(440px,60vh)] overflow-y-auto overscroll-contain"
      style={{ maskImage: edgeFadeMask(edges) }}
    >
      {groups.map((group) => (
        <section
          key={group.title}
          aria-label={headed ? group.title : undefined}
        >
          {headed ? (
            <p className="px-2 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-content/35">
              {group.title}
            </p>
          ) : null}
          <ul
            aria-label={
              headed ? `${group.title} servers` : `${title} MCP servers`
            }
          >
            {group.rows.map((row) => (
              <li
                key={row.name}
                className="flex items-center gap-2.5 rounded-lg px-2 py-1.5"
              >
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate text-[13px] text-content"
                    title={row.name}
                  >
                    {shownName(row.name, group.prefix)}
                  </span>
                  <span className="block truncate text-[11px] leading-4 text-content/45">
                    {row.detail}
                  </span>
                </span>
                {localityServer ? (
                  <ServerLocalityTag server={localityServer(row.name)} />
                ) : null}
                <ConnectorSwitch
                  label={row.name}
                  on={row.enabled}
                  disabled={row.configDisabled}
                  onChange={(on) => onToggle(row.name, on)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
