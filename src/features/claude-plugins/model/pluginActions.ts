import type { ClaudePlugin } from "./pluginCli";
import {
  marketplaceAddArgs,
  marketplaceListArgs,
  marketplaceRemoveArgs,
  marketplaceUpdateArgs,
  parseAvailablePlugins,
  parseManageResult,
  parseMarketplaceList,
  pluginInstallCall,
  pluginUninstallCall,
  pluginUpdateCall,
  type AvailablePlugin,
  type InstallScope,
  type ManageResult,
  type Marketplace,
  type PluginCall,
} from "./pluginManage";
import { refreshPlugins } from "./plugins";
import { runClaudePlugin } from "./runClaudePlugin";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs one change and reads its result. The installed list is read again
 * after a change that went through, so the page shows what Claude Code now
 * has. A call MonoCode cannot build is refused here, before anything runs.
 */
async function change(
  call: PluginCall | null,
  accountId: string | undefined,
): Promise<ManageResult> {
  if (!call) {
    return { ok: false, message: "MonoCode cannot pass this to Claude Code." };
  }
  let result: ManageResult;
  try {
    result = parseManageResult(
      await runClaudePlugin(call.args, { cwd: call.cwd, accountId }),
    );
  } catch (err) {
    return { ok: false, message: message(err) };
  }
  if (result.ok) await refreshPlugins(accountId);
  return result;
}

/**
 * Install a plugin. When Claude Code answers with a command it would run,
 * nothing was installed: show the command, and call again with its hash only
 * after the person accepts it.
 */
export function installPlugin(
  id: string,
  scope: InstallScope,
  cwd: string | undefined,
  accountId: string | undefined,
  acceptHash?: string,
): Promise<ManageResult> {
  return change(pluginInstallCall(id, scope, cwd, acceptHash), accountId);
}

export function updatePlugin(
  plugin: ClaudePlugin,
  accountId: string | undefined,
  acceptHash?: string,
): Promise<ManageResult> {
  return change(pluginUpdateCall(plugin, acceptHash), accountId);
}

export function uninstallPlugin(
  plugin: ClaudePlugin,
  deleteData: boolean,
  accountId: string | undefined,
): Promise<ManageResult> {
  return change(pluginUninstallCall(plugin, deleteData), accountId);
}

export async function listMarketplaces(
  accountId: string | undefined,
): Promise<Marketplace[]> {
  const output = await runClaudePlugin(marketplaceListArgs(), { accountId });
  return parseMarketplaceList(output.stdout);
}

/**
 * What the account's marketplaces offer, or why it could not be read. A
 * failed or unreadable reply is never shown as an empty list.
 */
export async function listAvailablePlugins(
  accountId: string | undefined,
): Promise<{ plugins: AvailablePlugin[] } | { error: string }> {
  try {
    const output = await runClaudePlugin(
      ["plugin", "list", "--json", "--available"],
      { accountId },
    );
    return { plugins: parseAvailablePlugins(output.stdout) };
  } catch (err) {
    return { error: message(err) };
  }
}

function asCall(args: string[] | null): PluginCall | null {
  return args ? { args } : null;
}

export function addMarketplace(
  source: string,
  accountId: string | undefined,
): Promise<ManageResult> {
  return change(asCall(marketplaceAddArgs(source)), accountId);
}

export function updateMarketplace(
  name: string,
  accountId: string | undefined,
): Promise<ManageResult> {
  return change(asCall(marketplaceUpdateArgs(name)), accountId);
}

export function removeMarketplace(
  name: string,
  accountId: string | undefined,
): Promise<ManageResult> {
  return change(asCall(marketplaceRemoveArgs(name)), accountId);
}
