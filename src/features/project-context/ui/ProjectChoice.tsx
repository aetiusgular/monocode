import { useMemo, useState } from "react";
import { SearchableProjectPicker } from "../../projects/ui/SearchableProjectPicker";
import {
  loadArchivedProjects,
  type RecentProject,
} from "../../projects/model/recents";
import { pathKey } from "../../../shared/lib/paths";

/** The open project first, then recent and archived ones, each once. */
export function projectChoices(
  cwd: string,
  recents: readonly RecentProject[],
  archived: readonly { path: string; archivedAt: number }[] = [],
): RecentProject[] {
  const choices: RecentProject[] = [];
  const seen = new Set<string>();
  const add = (choice: RecentProject) => {
    if (!choice.path || choice.path === "~") return;
    const key = pathKey(choice.path);
    if (seen.has(key)) return;
    seen.add(key);
    choices.push(choice);
  };
  add({ path: cwd, openedAt: Number.MAX_SAFE_INTEGER });
  recents.forEach(add);
  archived.forEach((item) =>
    add({ path: item.path, openedAt: item.archivedAt }),
  );
  return choices;
}

/** A project for a settings page to show, starting from the open one. */
export function useProjectChoice(
  cwd: string,
  recents: readonly RecentProject[],
) {
  const projects = useMemo(
    () => projectChoices(cwd, recents, safeArchived()),
    [cwd, recents],
  );
  const [project, setProject] = useState(
    cwd === "~" ? (projects[0]?.path ?? "") : cwd,
  );
  return { projects, project, setProject };
}

function safeArchived() {
  try {
    return loadArchivedProjects();
  } catch {
    return [];
  }
}

export function ProjectChoice({
  project,
  projects,
  onSelect,
}: {
  project: string;
  projects: RecentProject[];
  onSelect: (path: string) => void;
}) {
  return (
    <SearchableProjectPicker
      cwd={project || "~"}
      recents={projects}
      className="w-fit max-w-full shrink-0"
      buttonClassName="h-7.5 max-w-full gap-2 bg-content/5 px-2.5 text-[13px] hover:bg-content/12 active:scale-[0.98]"
      onSelectProject={onSelect}
    />
  );
}
