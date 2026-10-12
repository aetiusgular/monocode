import { useCallback, useEffect, useState } from "react";
import type { RecentProject } from "../../projects/model/recents";
import { readTextFile } from "../../../platform/tauri/fs";
import { projectName } from "../../../shared/lib/paths";
import {
  readGlobalContext,
  readProjectContext,
  saveGlobalContext,
  saveProjectContext,
} from "../model/projectContext";
import {
  agentsMdBesideClaudeMd,
  setAgentsMdBesideClaudeMd,
} from "../model/instructions";
import { preambleBudget } from "../../session-preamble/model/preamble";
import { ContextTextCard } from "./ContextTextCard";
import { ProjectChoice, useProjectChoice } from "./ProjectChoice";

const NOTE = "text-[11px] leading-4 text-content/45";

/**
 * Files a harness reads by itself, shown read only so the page lists
 * everything an agent is told. The default homes only: a named Codex
 * account's home is not listed.
 */
export const HARNESS_GLOBAL_FILES: { label: string; path: string }[] = [
  { label: "Claude Code, every project", path: "~/.claude/CLAUDE.md" },
  { label: "Codex, default home", path: "~/.codex/AGENTS.md" },
];

type FileState = { path: string; text: string | null };

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readTextFile(path);
  } catch {
    return null;
  }
}

function join(project: string, name: string): string {
  return `${project.replace(/[\\/]+$/, "")}/${name}`;
}

export function InstructionsPage({
  cwd,
  recents = [],
  onOpenFile,
}: {
  cwd: string;
  recents?: RecentProject[];
  /** Opens a file in MonoCode's editor. */
  onOpenFile?: (path: string) => void;
}) {
  const { projects, project, setProject } = useProjectChoice(cwd, recents);
  const [shared, setShared] = useState<FileState[]>([]);
  const [harnessFiles, setHarnessFiles] = useState<FileState[]>([]);
  const [agentsMdBoth, setAgentsMdBoth] = useState(agentsMdBesideClaudeMd());

  useEffect(() => {
    let live = true;
    const paths = project
      ? [join(project, "AGENTS.md"), join(project, "CLAUDE.md")]
      : [];
    void Promise.all(
      paths.map(async (path) => ({ path, text: await readOptional(path) })),
    ).then((files) => live && setShared(files));
    return () => {
      live = false;
    };
  }, [project]);
  useEffect(() => {
    let live = true;
    void Promise.all(
      HARNESS_GLOBAL_FILES.map(async ({ path }) => ({
        path,
        text: await readOptional(path),
      })),
    ).then((files) => live && setHarnessFiles(files));
    return () => {
      live = false;
    };
  }, []);

  const loadGlobal = useCallback(
    () => readGlobalContext("instructions.md"),
    [],
  );
  const saveGlobal = useCallback(
    (text: string, hash: string) =>
      saveGlobalContext("instructions.md", text, hash),
    [],
  );
  const loadNotes = useCallback(
    () => readProjectContext(project, "notes.md"),
    [project],
  );
  const saveNotes = useCallback(
    (text: string, hash: string) =>
      saveProjectContext(project, "notes.md", text, hash),
    [project],
  );
  const agentsMd = shared.find((file) => file.path.endsWith("AGENTS.md"));
  const claudeMd = shared.find((file) => file.path.endsWith("CLAUDE.md"));

  return (
    <div data-instructions-page className="flex flex-col gap-6">
      <p className={NOTE}>
        MonoCode adds your instructions, a project&apos;s private notes and its
        memory to each chat, within a budget set by the model: up to{" "}
        {preambleBudget(16_384).toLocaleString("en-US")} characters for a
        16k-token local model and{" "}
        {preambleBudget(200_000).toLocaleString("en-US")} for a large one.
        Memory is cut first, your instructions last. Each chat&apos;s Context
        section shows what did not fit.
      </p>
      <ContextTextCard
        id="instructions-global"
        title="Your instructions"
        hint="For every project and every harness. Not stored in any repository."
        placeholder="For example: Answer in short declaratives. Never commit for me."
        load={loadGlobal}
        save={saveGlobal}
      />
      <div className="flex flex-col gap-2">
        <ProjectChoice
          project={project}
          projects={projects}
          onSelect={setProject}
        />
        {project ? (
          <ContextTextCard
            key={project}
            id="instructions-project"
            title={`Private notes for ${projectName(project)}`}
            hint="Only you and the agent see these. They stay out of the repository, unlike AGENTS.md."
            placeholder="For example: The staging database is read only."
            load={loadNotes}
            save={saveNotes}
          />
        ) : (
          <p className={NOTE}>Open a project to add notes for it.</p>
        )}
      </div>
      {project ? (
        <section
          data-setting-id="instructions-agents-md"
          id="setting-instructions-agents-md"
          className="flex flex-col gap-1.5"
        >
          <h3 className="text-[13px] font-medium text-content">
            Shared instructions: AGENTS.md
          </h3>
          <p className={NOTE}>
            In the repository, for everyone who works on it. Every harness reads
            it, each under its own conditions.
          </p>
          {agentsMd?.text != null ? (
            <button
              type="button"
              data-open-agents-md
              disabled={!onOpenFile}
              className="h-7 w-fit rounded-md bg-content/8 px-2.5 text-[12px] text-content hover:bg-content/14 disabled:opacity-40"
              onClick={() => agentsMd && onOpenFile?.(agentsMd.path)}
            >
              Open AGENTS.md
            </button>
          ) : (
            <p className={NOTE}>
              This project has no AGENTS.md yet. Ask an agent to write one, or
              create it in your editor.
            </p>
          )}
          <label className="flex items-center gap-2 text-[12px] text-content/80">
            <input
              type="checkbox"
              data-agents-md-both
              checked={agentsMdBoth}
              onChange={(event) => {
                const on = event.currentTarget.checked;
                setAgentsMdBesideClaudeMd(on);
                setAgentsMdBoth(on);
              }}
            />
            Claude Code reads AGENTS.md beside CLAUDE.md
          </label>
          <p className={NOTE}>
            {claudeMd?.text != null
              ? "This project has a CLAUDE.md. Without this switch Claude Code reads only that."
              : "Claude Code 2.1.277 or later. Applies when a chat's Claude Code next starts."}
          </p>
        </section>
      ) : null}
      <section
        data-setting-id="instructions-harness-files"
        id="setting-instructions-harness-files"
        className="flex flex-col gap-1.5"
      >
        <h3 className="text-[13px] font-medium text-content">
          What harnesses read by themselves
        </h3>
        <p className={NOTE}>Read only. Edit them in your editor.</p>
        {HARNESS_GLOBAL_FILES.map(({ label, path }) => {
          const file = harnessFiles.find((entry) => entry.path === path);
          return (
            <details key={path} className="rounded-md bg-content/4 px-2 py-1.5">
              <summary className="cursor-pointer text-[12px] text-content/80">
                {label}: <span className="font-mono">{path}</span>
                {file?.text == null ? " (none)" : ""}
              </summary>
              {file?.text != null ? (
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-content/70">
                  {file.text}
                </pre>
              ) : null}
            </details>
          );
        })}
      </section>
    </div>
  );
}
