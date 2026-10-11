import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { TitleBar, type Tab } from "../../src/app/shell/TitleBar";
import { projectKey } from "../../src/shared/lib/paths";
import { orderByIds } from "../../src/shared/lib/reorder";
import "../../src/styles/index.css";

/**
 * The title bar on its own, with tabs from three projects: beta has a custom
 * colour and a working tab, gamma has one tab in a worktree and one with a
 * finished, unseen reply. `?single=1` keeps every tab in alpha; `?keep=1`
 * leaves saved state alone across a reload.
 */

const PARAMS = new URLSearchParams(location.search);
const SINGLE = PARAMS.get("single") === "1";
if (PARAMS.get("keep") !== "1") localStorage.clear();

const ALPHA = "/Users/me/Projects/alpha";
const BETA = "/Users/me/Projects/beta";
const GAMMA = "/Users/me/Projects/gamma";

// Saved appearance, as the project rail would have written it.
localStorage.setItem("monocode:tab-group:key-version", "2");
localStorage.setItem(
  "monocode:tab-group:logos",
  JSON.stringify({ [projectKey(ALPHA)]: "/monocode.png" }),
);
localStorage.setItem(
  "monocode:tab-group:custom-colors",
  JSON.stringify({ [projectKey(BETA)]: "#ff8800" }),
);

(
  window as unknown as {
    __TAURI_INTERNALS__: {
      invoke: (command: string) => Promise<unknown>;
      convertFileSrc: (path: string) => string;
    };
  }
).__TAURI_INTERNALS__ = {
  invoke: async (command) => {
    throw new Error(`The fixture has no ${command}.`);
  },
  convertFileSrc: (path) => path,
};

function tab(
  id: string,
  project: string,
  projectPath: string,
  title: string,
  extra: Partial<Tab> = {},
): Tab {
  return {
    id,
    project,
    projectPath,
    title,
    more: [],
    sessionCount: 1,
    harnesses: ["codex"],
    busyHarnesses: [],
    doneHarnesses: [],
    files: [],
    ...extra,
  };
}

const TABS: Tab[] = SINGLE
  ? [
      tab("a1", "alpha", ALPHA, "Fix the build"),
      tab("a2", "alpha", ALPHA, "Add tests"),
      tab("a3", "alpha", ALPHA, "Write the changelog"),
    ]
  : [
      tab("a1", "alpha", ALPHA, "Fix the build"),
      tab("a2", "alpha", ALPHA, "Add tests"),
      tab("b1", "beta", BETA, "Migrate the schema", {
        busyHarnesses: ["codex"],
      }),
      tab("g1", "gamma", GAMMA, "Ship the release", {
        harnesses: ["claude"],
        doneHarnesses: ["claude"],
      }),
      tab("g2", "gamma", GAMMA, "Try the new parser", {
        worktree: "feature-x",
        sessionCount: 2,
        more: ["Second chat"],
      }),
    ];

function Fixture() {
  const [tabs, setTabs] = useState(TABS);
  const [activeId, setActiveId] = useState("a1");
  const onReorder = useCallback((ids: string[]) => {
    setTabs((prev) => orderByIds(prev, ids));
  }, []);
  const onClose = useCallback((id: string) => {
    setTabs((prev) => prev.filter((entry) => entry.id !== id));
  }, []);
  const onCloseMany = useCallback((ids: string[], fallbackId: string) => {
    const closing = new Set(ids);
    setTabs((prev) => prev.filter((entry) => !closing.has(entry.id)));
    setActiveId((current) => (closing.has(current) ? fallbackId : current));
  }, []);
  return (
    <div className="flex h-full flex-col bg-background-base text-content">
      <TitleBar
        tabs={tabs}
        activeId={activeId}
        cwd={ALPHA}
        groupByProject
        hideWindowControls
        onToggleSidebar={() => {}}
        onSelect={setActiveId}
        onClose={onClose}
        onCloseMany={onCloseMany}
        onReorder={onReorder}
      />
      <p data-active className="p-4 text-sm text-content/60">
        Active: {activeId}
      </p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
