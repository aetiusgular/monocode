import { useEffect, useState } from "react";
import {
  parsePluginList,
  pluginListArgs,
  type ClaudePlugin,
} from "./pluginCli";
import { runClaudePlugin } from "./runClaudePlugin";

export type ChatPluginList = {
  plugins: ClaudePlugin[] | null;
  loading: boolean;
  error: string | null;
};

/** Last list per account and folder, shown while a fresh one is read. */
const lastLists = new Map<string, ClaudePlugin[]>();

/**
 * The plugins Claude Code reports for a chat's folder and account, read
 * afresh each time the chat's plugin list opens. `enabled` on each entry is
 * what the folder's merged settings say, before the chat's own switches.
 */
export function useChatPluginList(
  cwd: string,
  accountId: string | undefined,
): ChatPluginList {
  const key = `${accountId ?? "default"}|${cwd}`;
  const [state, setState] = useState<ChatPluginList>(() => ({
    plugins: lastLists.get(key) ?? null,
    loading: true,
    error: null,
  }));
  useEffect(() => {
    let live = true;
    setState({
      plugins: lastLists.get(key) ?? null,
      loading: true,
      error: null,
    });
    runClaudePlugin(pluginListArgs(), { cwd, accountId })
      .then((output) => {
        const plugins = parsePluginList(output.stdout);
        lastLists.set(key, plugins);
        if (live) setState({ plugins, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (!live) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      });
    return () => {
      live = false;
    };
  }, [key, cwd, accountId]);
  return state;
}

/** For tests. */
export function __resetChatPluginLists(): void {
  lastLists.clear();
}
