import { useEffect, useMemo, useState } from "react";
import { useReportedMcpServers } from "../../session-tools/model/reportedMcpServers";
import type { HarnessId, RuntimeMode } from "../../sessions/model/session";
import {
  getCachedMcpSettings,
  subscribeMcpSettings,
  type McpServerRow,
} from "../../settings/model/mcpSettingsCache";
import { browserServers } from "../model/browserTools";

const NONE: McpServerRow[] = [];

/** The provider a configured server belongs to, for a harness. */
const PROVIDER: Partial<Record<HarnessId, McpServerRow["provider"]>> = {
  claude: "claude",
  codex: "codex",
};

/**
 * The browser MCP servers a chat's next turn can use: those configured on
 * this computer for the harness, and those Claude Code reported. It reads
 * caches only; research mode and the connector menu load them.
 */
export function useBrowserServers(input: {
  harness: HarnessId;
  cwd: string;
  sessionId?: string;
  providerAccountId?: string;
  on: boolean;
}): string[] {
  const { harness, cwd, sessionId, providerAccountId, on } = input;
  const reported = useReportedMcpServers(
    sessionId,
    providerAccountId,
    on && harness === "claude",
  );
  const [configured, setConfigured] = useState<McpServerRow[]>(
    () => (on && getCachedMcpSettings(cwd)?.servers) || NONE,
  );
  useEffect(() => {
    if (!on || !cwd) {
      setConfigured(NONE);
      return;
    }
    setConfigured(getCachedMcpSettings(cwd)?.servers ?? NONE);
    return subscribeMcpSettings(cwd, (snapshot) =>
      setConfigured(snapshot.servers),
    );
  }, [cwd, on]);
  return useMemo(() => {
    if (!on) return [];
    const provider = PROVIDER[harness];
    const names = [
      ...configured
        .filter((row) => row.provider === provider && row.enabled !== false)
        .map((row) => row.name),
      ...(reported ?? []).map((server) => server.name),
    ];
    return browserServers(names);
  }, [configured, harness, on, reported]);
}

/** Whether every browser server is switched on for the chat. */
export function browserToolsOn(
  servers: readonly string[],
  disabled: readonly string[],
): boolean {
  return (
    servers.length > 0 && servers.every((name) => !disabled.includes(name))
  );
}

/** The chat's switched-off list with every browser server on or off. */
export function withBrowserTools(
  servers: readonly string[],
  disabled: readonly string[],
  on: boolean,
): string[] {
  const rest = disabled.filter((name) => !servers.includes(name));
  return on ? rest : [...rest, ...servers];
}

/**
 * Notes under the switch: where site approval works, and Full access, which
 * never asks. Exported for tests.
 */
export function browserToolsNotes(
  harness: HarnessId,
  runtimeMode: RuntimeMode,
): string[] {
  const notes: string[] = [];
  if (harness !== "claude")
    notes.push(
      "Sites are not asked on this harness: it does not tell MonoCode which page a tool opens.",
    );
  else if (runtimeMode === "full-access")
    notes.push("Full access never asks: every site opens without a card.");
  else
    notes.push(
      "Each new site asks first. Choose once, this chat, this project or never.",
    );
  return notes;
}

/**
 * "Browser tools" in the plus menu: one switch for every browser MCP server
 * the chat has, listed by name. Off adds them to the chat's switched-off
 * servers; on removes them. Hidden when the chat has none.
 */
export function BrowserToolsMenuItem({
  servers,
  disabled,
  harness,
  runtimeMode,
  onChange,
  className,
}: {
  servers: readonly string[];
  disabled: readonly string[];
  harness: HarnessId;
  runtimeMode: RuntimeMode;
  onChange: (names: string[]) => void;
  className?: string;
}) {
  if (servers.length === 0) return null;
  const on = browserToolsOn(servers, disabled);
  const notes = browserToolsNotes(harness, runtimeMode);
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={on}
      data-browser-tools
      title={notes.join(" ")}
      className={
        className ??
        "flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-content/85 hover:bg-content/8"
      }
      onClick={() => onChange(withBrowserTools(servers, disabled, !on))}
    >
      <span className="min-w-0 flex-1">
        <span className="block">Browser tools {on ? "on" : "off"}</span>
        <span className="block truncate text-[11px] text-content/50">
          {servers.join(", ")}
        </span>
        <span className="block text-[11px] text-content/50">{notes[0]}</span>
      </span>
    </button>
  );
}
