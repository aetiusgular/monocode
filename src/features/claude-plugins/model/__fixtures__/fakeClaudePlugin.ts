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
  const fake = { fail: options.fail, plugins, on };
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
              ? { installed: list, available: [] }
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
