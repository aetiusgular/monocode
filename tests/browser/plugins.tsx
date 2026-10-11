import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Mock } from "vitest";
import {
  fakeClaudePlugin,
  PLUGIN_LIST_FIXTURE,
} from "../../src/features/claude-plugins/model/__fixtures__/fakeClaudePlugin";
import { chatDisabledPlugins } from "../../src/features/claude-plugins/model/chatPlugins";
import { PluginsMenuItem } from "../../src/features/claude-plugins/ui/PluginsMenuItem";
import { PluginsPage } from "../../src/features/claude-plugins/ui/PluginsPage";
import { PluginsPopover } from "../../src/features/claude-plugins/ui/PluginsPopover";
import {
  sessionToolsSummary,
  withSessionToolsPatch,
} from "../../src/features/session-tools/model/harnessInput";
import {
  newSession,
  type Session,
} from "../../src/features/sessions/model/session";
import { Popover } from "../../src/shared/ui/Popover";
import "../../src/styles/index.css";

const PARAMS = new URLSearchParams(location.search);
const VIEW = PARAMS.get("view") === "settings" ? "settings" : "chat";
const PROJECT = "/Users/me/Projects/resale-platform";

localStorage.clear();

/** Tony's list, plus a long name and a managed plugin to lay out. */
const PLUGINS = [
  ...PLUGIN_LIST_FIXTURE,
  {
    id: "enterprise-security-review-and-compliance-toolkit@first-party-plugins",
    version: "3.4.0",
    scope: "user",
    enabled: false,
    installPath: "/Users/me/.claude/plugins/cache/first-party/esr/3.4.0",
    mcpServers: { "security-scanner": {}, "policy-docs": {} },
  },
  {
    id: "policy@corp-marketplace",
    version: "1.0.0",
    scope: "managed",
    enabled: true,
    installPath: "/Library/Application Support/ClaudeCode/plugins/policy",
  },
];

const calls: { args: string[]; cwd?: string; accountId?: string }[] = [];
(window as unknown as { __plugins: typeof calls }).__plugins = calls;

type Impl = (
  args: string[],
  options?: { cwd?: string; accountId?: string },
) => Promise<unknown>;
let impl: Impl = async () => undefined;
const shim = {
  mockImplementation: (next: Impl) => {
    impl = next;
  },
};
fakeClaudePlugin(shim as unknown as Mock, {
  plugins: PLUGINS,
  required: ["browser-use@synced"],
});

/** Folders a plugin's install path holds, for "what it brings". */
const TREE: Record<string, { name: string; isDir: boolean }[]> = {
  [PLUGIN_LIST_FIXTURE[0].installPath as string]: [
    { name: "skills", isDir: true },
    { name: "commands", isDir: true },
  ],
  [`${PLUGIN_LIST_FIXTURE[0].installPath as string}/skills`]: [
    { name: "obsidian-markdown", isDir: true },
    { name: "obsidian-bases", isDir: true },
    { name: "json-canvas", isDir: true },
  ],
  [`${PLUGIN_LIST_FIXTURE[0].installPath as string}/commands`]: [
    { name: "daily.md", isDir: false },
  ],
};

(
  window as unknown as {
    __TAURI_INTERNALS__: {
      invoke: (
        command: string,
        args?: Record<string, unknown>,
      ) => Promise<unknown>;
    };
  }
).__TAURI_INTERNALS__ = {
  invoke: async (command, payload) => {
    if (command === "list_dir") {
      const entries = TREE[payload?.path as string];
      if (!entries) throw new Error("No such folder");
      return entries.map((entry) => ({ ...entry, path: "", ignored: false }));
    }
    if (command !== "claude_plugin") {
      throw new Error(`The fixture has no ${command}.`);
    }
    const args = payload?.args as string[];
    const cwd = (payload?.cwd as string | null) ?? undefined;
    const accountId = (payload?.accountId as string | null) ?? undefined;
    calls.push({ args, cwd, accountId });
    // Slow enough to see a switch wait for the CLI.
    await new Promise((resolve) => setTimeout(resolve, 60));
    return impl(args, { cwd, accountId });
  },
};

const opened: string[] = [];
(window as unknown as { __opened: string[] }).__opened = opened;

/** The page inside the same frame Settings gives it. */
function SettingsFixture() {
  return (
    <div className="@container/settings h-full overflow-y-auto bg-background-base">
      <div className="mx-auto w-full max-w-5xl px-5 py-6 @min-[560px]/settings:px-8 @min-[560px]/settings:py-8">
        <header className="pb-4">
          <h1 className="text-[20px] font-semibold leading-tight text-content">
            Plugins
          </h1>
        </header>
        <PluginsPage cwd={PROJECT} />
      </div>
    </div>
  );
}

/** The composer cut down to its plus menu, for a Claude Code chat. */
function ChatFixture() {
  const [session, setSession] = useState<Session>(() => ({
    ...newSession("claude", PROJECT),
    id: "fixture",
  }));
  const [open, setOpen] = useState<"plus" | "plugins" | null>(null);
  const plus = useRef<HTMLDivElement>(null);
  const plusButton = useRef<HTMLButtonElement>(null);
  const off = chatDisabledPlugins(session.harness, session.disabledPlugins);
  const summary = sessionToolsSummary(session, session.cwd);
  return (
    <div className="flex h-full min-h-0 flex-col justify-end bg-background-base text-content">
      <div className="flex items-center gap-2 border-t border-content/10 px-3 py-2">
        <div ref={plus} className="relative shrink-0">
          <button
            ref={plusButton}
            type="button"
            aria-label="Add files or choose a mode"
            onClick={() => setOpen((shown) => (shown ? null : "plus"))}
            className="grid size-7 place-items-center rounded-md bg-content/10 text-[13px]"
          >
            +
          </button>
          {open === "plus" ? (
            <Popover
              anchor={plus}
              side="top"
              align="start"
              width={250}
              onDismiss={() => setOpen(null)}
              data-composer-plus
              className="p-1.5"
            >
              <PluginsMenuItem
                offCount={off.length}
                onOpen={() => setOpen("plugins")}
              />
            </Popover>
          ) : null}
          {open === "plugins" ? (
            <PluginsPopover
              anchor={plus}
              cwd={session.cwd}
              disabled={off}
              atTurnStart={null}
              onChange={(disabledPlugins) =>
                setSession((current) =>
                  withSessionToolsPatch(current, { disabledPlugins }),
                )
              }
              onManage={() => {
                opened.push("plugins-settings");
                setOpen(null);
              }}
              onDismiss={(reason) => {
                setOpen(null);
                if (reason === "escape") plusButton.current?.focus();
              }}
            />
          ) : null}
        </div>
        <span data-summary className="text-[11px] text-content/70">
          {summary?.label ?? ""}
        </span>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  VIEW === "settings" ? <SettingsFixture /> : <ChatFixture />,
);
