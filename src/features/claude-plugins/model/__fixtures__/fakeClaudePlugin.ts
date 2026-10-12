import type { Mock } from "vitest";

type Entry = Record<string, unknown> & {
  id: string;
  scope: string;
  enabled: boolean;
  projectPath?: string;
};

/**
 * Entries in the shape `claude plugin list --json` printed on Tony's Mac
 * (Claude Code 2.1.296, 10 Oct 2026), paths shortened.
 */
export const PLUGIN_LIST_FIXTURE: Entry[] = [
  {
    id: "obsidian@obsidian-skills",
    version: "1.0.1",
    scope: "user",
    enabled: true,
    installPath:
      "/Users/me/.claude/plugins/cache/obsidian-skills/obsidian/1.0.1",
    installedAt: "2026-06-15T19:12:30.006Z",
    lastUpdated: "2026-06-15T19:12:30.006Z",
    projectEnabled: false,
  },
  {
    id: "paper-desktop@paper",
    version: "0.2.1",
    scope: "user",
    enabled: true,
    installPath: "/Users/me/.claude/plugins/cache/paper/paper-desktop/0.2.1",
    mcpServers: {
      paper: { command: "${HOME}/.paper/bin/paper", args: ["mcp"] },
    },
    projectEnabled: false,
  },
  {
    id: "stripe@claude-plugins-official",
    version: "0.10.3",
    scope: "local",
    enabled: false,
    installPath:
      "/Users/me/.claude/plugins/cache/claude-plugins-official/stripe/0.10.3",
    projectPath: "/Users/me/Projects/resale-platform",
    projectEnabled: false,
  },
  {
    id: "browser-use@synced",
    version: "unknown",
    scope: "synced",
    enabled: true,
    installPath: "/Users/me/.claude/plugins/synced/browser-use",
  },
];

type Options = {
  plugins?: Entry[];
  /** Every call rejects with this. */
  fail?: string;
  /** `disable` of these ids fails the way a required synced plugin does. */
  required?: string[];
  /** Marketplaces `marketplace list --json` reports. */
  marketplaces?: { name: string; source: string; repo?: string }[];
  /** What `list --json --available` offers. */
  available?: {
    pluginId: string;
    name: string;
    marketplaceName: string;
    description?: string;
  }[];
  /** Plugin ids installed by running a command, with that command. */
  commandSources?: Record<string, string>;
};

const result = (value: Record<string, unknown>, success: boolean) => ({
  stdout: `${JSON.stringify(value)}\n`,
  stderr: "",
  success,
});

/**
 * A fake `claude plugin` that keeps each installation's state. A `local` or
 * `project` installation reports itself enabled only from its own project's
 * folder, as Claude Code merges settings for the folder it runs in. Enable
 * and disable answer with a `--json` result line and exit 1 on failure.
 */
export function fakeClaudePlugin(runClaudePlugin: Mock, options: Options = {}) {
  const plugins: Entry[] = (options.plugins ?? PLUGIN_LIST_FIXTURE).map(
    (entry) => ({ ...entry }),
  );
  // State per installation, before folder rules.
  const on = new Map<string, boolean>(
    plugins.map((entry) => [
      `${entry.id}|${entry.scope}`,
      entry.scope === "local" || entry.scope === "project"
        ? true
        : entry.enabled,
    ]),
  );
  const marketplaces = (options.marketplaces ?? []).map((entry) => ({
    ...entry,
  }));
  const fake = { fail: options.fail, plugins, on, marketplaces };
  runClaudePlugin.mockImplementation(
    async (args: string[], call: { cwd?: string; accountId?: string } = {}) => {
      if (fake.fail) throw new Error(fake.fail);
      const [, verb] = args;
      if (verb === "list") {
        const list = plugins.map((entry) => ({
          ...entry,
          enabled:
            entry.scope === "local" || entry.scope === "project"
              ? call.cwd === entry.projectPath &&
                on.get(`${entry.id}|${entry.scope}`) === true
              : on.get(`${entry.id}|${entry.scope}`) === true,
        }));
        return {
          stdout: JSON.stringify(
            args.includes("--available")
              ? { installed: list, available: options.available ?? [] }
              : list,
          ),
          stderr: "",
          success: true,
        };
      }
      if (verb === "enable" || verb === "disable") {
        const id = args[args.length - 1];
        const scoped = args[2] === "--scope" ? args[3] : undefined;
        const entry = plugins.find(
          (candidate) =>
            candidate.id === id &&
            (scoped
              ? candidate.scope === scoped
              : candidate.scope === "synced"),
        );
        if (!entry) {
          return result(
            {
              command: verb,
              outcome: "failed",
              message: `Plugin "${id}" is not installed at ${scoped} scope.`,
            },
            false,
          );
        }
        if (
          (entry.scope === "local" || entry.scope === "project") &&
          call.cwd !== entry.projectPath
        ) {
          return result(
            {
              command: verb,
              outcome: "failed",
              message: `Plugin "${id}" is not declared in this project.`,
            },
            false,
          );
        }
        if (verb === "disable" && options.required?.includes(id)) {
          return result(
            {
              command: verb,
              outcome: "failed",
              message: `Plugin "${id}" is required by your organization and can't be disabled here. Contact your admin to change it.`,
            },
            false,
          );
        }
        const key = `${entry.id}|${entry.scope}`;
        const want = verb === "enable";
        if (on.get(key) === want) {
          return result(
            {
              command: verb,
              outcome: "failed",
              message: `Plugin "${id}" is already ${want ? "enabled" : "disabled"}`,
              failureCode: "already_in_goal_state",
              alreadyInGoalState: true,
            },
            false,
          );
        }
        on.set(key, want);
        return result(
          { command: verb, outcome: "ok", message: "done", pluginId: id },
          true,
        );
      }
      if (verb === "marketplace") {
        const [, , action] = args;
        const name = args[args.length - 1];
        const known = marketplaces.some((entry) => entry.name === name);
        if (action === "list") {
          return {
            stdout: JSON.stringify(marketplaces),
            stderr: "",
            success: true,
          };
        }
        if (action === "add") {
          const added = name.split("/").pop() ?? name;
          marketplaces.push({ name: added, source: "github", repo: name });
          return result(
            {
              command: "marketplace-add",
              outcome: "ok",
              marketplace: added,
              message: `Successfully added marketplace: ${added}`,
            },
            true,
          );
        }
        if (!known) {
          return result(
            {
              command: `marketplace-${action}`,
              outcome: "failed",
              marketplace: name,
              message: `Marketplace '${name}' not found`,
              failureCode: "not_configured",
            },
            false,
          );
        }
        if (action === "remove") {
          marketplaces.splice(
            marketplaces.findIndex((entry) => entry.name === name),
            1,
          );
          for (let i = plugins.length - 1; i >= 0; i--) {
            if (plugins[i].id.endsWith(`@${name}`)) plugins.splice(i, 1);
          }
        }
        return result(
          {
            command: `marketplace-${action}`,
            outcome: "ok",
            marketplace: name,
            message: `Successfully ${action}d marketplace: ${name}`,
          },
          true,
        );
      }
      if (verb === "install" || verb === "update" || verb === "uninstall") {
        const id = args[args.length - 1];
        const scope = args[3];
        const hashAt = args.indexOf("--accept-command");
        const command = options.commandSources?.[id];
        const sha256 = "a".repeat(64);
        if (
          verb !== "uninstall" &&
          command &&
          (hashAt < 0 || args[hashAt + 1] !== sha256)
        ) {
          return {
            stdout: `"${id}" is installed by running a command:\n  ${command}\n${JSON.stringify(
              {
                command: verb,
                outcome: "failed",
                plugin: id,
                scope,
                message: `${id} is installed by running a command on this machine that has not been reviewed yet, so it was not run.`,
                failureCode: "command_source_refused",
                shownCommand: {
                  kind: "command_source",
                  pluginId: id,
                  command,
                  mode: "copy",
                  catalogRevision: "sha256:x",
                  sha256,
                },
              },
            )}\n`,
            stderr: "",
            success: false,
          };
        }
        if (verb === "install") {
          plugins.push({
            id,
            version: "1.0.0",
            scope,
            enabled: true,
            installPath: `/fake/cache/${id}`,
            ...(scope === "user" ? {} : { projectPath: call.cwd }),
          });
          on.set(`${id}|${scope}`, true);
        }
        if (verb === "uninstall") {
          const at = plugins.findIndex(
            (entry) => entry.id === id && entry.scope === scope,
          );
          if (at < 0) {
            return result(
              {
                command: verb,
                outcome: "failed",
                plugin: id,
                scope,
                message: `Plugin "${id}" not found in installed plugins`,
                failureCode: "not_installed",
              },
              false,
            );
          }
          plugins.splice(at, 1);
        }
        return result(
          {
            command: verb,
            outcome: "ok",
            plugin: id,
            pluginId: id,
            scope,
            message: `Successfully ${verb === "update" ? "updated" : `${verb}ed`} plugin: ${id}`,
          },
          true,
        );
      }
      throw new Error("claude_plugin: unsupported arguments");
    },
  );
  return fake;
}

/** The argument lists the fake was called with, joined, and their folders. */
export function pluginCalls(runClaudePlugin: Mock): string[] {
  return runClaudePlugin.mock.calls.map((call) => {
    const options = (call[1] ?? {}) as { cwd?: string };
    return `${(call[0] as string[]).join(" ")}${options.cwd ? ` @ ${options.cwd}` : ""}`;
  });
}
