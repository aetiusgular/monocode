import { useCallback, useEffect, useState } from "react";
import type { RecentProject } from "../../projects/model/recents";
import { projectName } from "../../../shared/lib/paths";
import {
  readProjectContext,
  subscribeProjectContext,
} from "../../project-context/model/projectContext";
import {
  ProjectChoice,
  useProjectChoice,
} from "../../project-context/ui/ProjectChoice";
import {
  addProjectMemory,
  lineAt,
  memoryEntries,
  removeEntryAt,
  setEntryLocal,
  type ProjectMemoryEntry,
} from "../model/projectMemory";
import {
  acceptProposal,
  loadProposals,
  rejectProposal,
  type MemoryProposal,
} from "../model/proposals";

const NOTE = "text-[11px] leading-4 text-content/45";
const BUTTON =
  "h-6.5 rounded-md px-2 text-[11px] text-content/70 hover:bg-content/10 disabled:opacity-40";

type Loaded = {
  text: string;
  entries: ProjectMemoryEntry[];
  archived: number;
  proposals: MemoryProposal[];
};

/**
 * #36: one project's memory, owned by MonoCode. Entries are one dated line
 * each. The newest that fit go to every chat on the project, within the
 * model's budget; local-only ones go only to a local session.
 */
export function MemoryPage({
  cwd,
  recents = [],
}: {
  cwd: string;
  recents?: RecentProject[];
}) {
  const { projects, project, setProject } = useProjectChoice(cwd, recents);
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState("");
  const [draftLocal, setDraftLocal] = useState(false);

  const refresh = useCallback(() => {
    if (!project) return setLoaded(undefined);
    void Promise.all([
      readProjectContext(project, "MEMORY.md"),
      readProjectContext(project, "archive.md"),
      loadProposals(project).catch(() => [] as MemoryProposal[]),
    ])
      .then(([memory, archive, proposals]) => {
        const text = memory.text ?? "";
        setLoaded({
          text,
          entries: memoryEntries(text).filter((entry) => !entry.struck),
          archived: memoryEntries(archive.text ?? "").length,
          proposals,
        });
        setError(undefined);
      })
      .catch((cause) => setError(`Could not read memory: ${String(cause)}`));
  }, [project]);
  useEffect(() => {
    refresh();
    return subscribeProjectContext(refresh);
  }, [refresh]);

  const run = (work: Promise<unknown>) =>
    void work
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(refresh);

  return (
    <div data-memory-page className="flex flex-col gap-4">
      <p className={NOTE}>
        MonoCode keeps this memory, not the harness, so it follows the project
        across Claude Code, Codex and the rest. The newest entries that fit the
        model&apos;s budget go to each chat; the rest stay searchable by an
        agent with app access. Agents only propose; nothing is saved without
        your click. A chat can switch memory off in its session panel.
      </p>
      <ProjectChoice
        project={project}
        projects={projects}
        onSelect={setProject}
      />
      {!project ? (
        <p className={NOTE}>Open a project to see its memory.</p>
      ) : (
        <>
          {loaded?.proposals.length ? (
            <section
              data-setting-id="memory-proposals"
              id="setting-memory-proposals"
              className="flex flex-col gap-1.5"
            >
              <h3 className="text-[13px] font-medium text-content">
                Waiting for you
              </h3>
              {loaded.proposals.map((proposal) => (
                <div
                  key={proposal.id}
                  data-memory-proposal={proposal.id}
                  className="flex items-start gap-2 rounded-md bg-content/5 px-2 py-1.5 text-[12px]"
                >
                  <span className="min-w-0 flex-1 text-content/85">
                    {proposal.fact}
                    <span className="ml-1 text-content/45">
                      {proposal.source === "agent"
                        ? "from an agent"
                        : "suggested"}
                      {proposal.local ? ", local only" : ""}
                      {proposal.replaces
                        ? `, replaces “${proposal.replaces}”`
                        : ""}
                    </span>
                  </span>
                  <button
                    type="button"
                    data-proposal-accept
                    className={BUTTON}
                    onClick={() => run(acceptProposal(project, proposal.id))}
                  >
                    Remember
                  </button>
                  <button
                    type="button"
                    data-proposal-reject
                    className={BUTTON}
                    onClick={() => run(rejectProposal(project, proposal.id))}
                  >
                    Dismiss
                  </button>
                </div>
              ))}
            </section>
          ) : null}
          <section
            data-setting-id="memory-entries"
            id="setting-memory-entries"
            className="flex flex-col gap-1.5"
          >
            <h3 className="text-[13px] font-medium text-content">
              {projectName(project)} memory
            </h3>
            {loaded && !loaded.entries.length ? (
              <p className={NOTE}>Nothing remembered yet.</p>
            ) : null}
            {loaded?.entries.map((entry) => {
              const line = lineAt(loaded.text, entry.index);
              return (
                <div
                  key={`${entry.index}:${line}`}
                  data-memory-entry={entry.index}
                  className="flex items-start gap-2 text-[12px]"
                >
                  <span className="w-20 shrink-0 font-mono text-[11px] text-content/40">
                    {entry.date ?? ""}
                  </span>
                  <span className="min-w-0 flex-1 text-content/85">
                    {entry.text}
                    {entry.until ? (
                      <span className="ml-1 text-content/45">
                        until {entry.until}
                      </span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    data-memory-local
                    title={
                      entry.local
                        ? "Goes only to local sessions. Click to share with hosted ones."
                        : "Goes to every session. Click to keep it to local sessions."
                    }
                    className={BUTTON}
                    onClick={() =>
                      run(
                        setEntryLocal(project, entry.index, line, !entry.local),
                      )
                    }
                  >
                    {entry.local ? "Local only" : "Everywhere"}
                  </button>
                  <button
                    type="button"
                    data-memory-remove
                    className={BUTTON}
                    onClick={() =>
                      run(removeEntryAt(project, entry.index, line))
                    }
                  >
                    Remove
                  </button>
                </div>
              );
            })}
            {loaded?.archived ? (
              <p className={NOTE}>
                {loaded.archived} older{" "}
                {loaded.archived === 1 ? "entry was" : "entries were"} moved to
                the archive to keep this list within what loads.
              </p>
            ) : null}
          </section>
          <section
            data-setting-id="memory-add"
            id="setting-memory-add"
            className="flex flex-col gap-1.5"
          >
            <h3 className="text-[13px] font-medium text-content">
              Add a memory
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              <input
                data-memory-draft
                value={draft}
                placeholder="One fact, such as: Tests run with npm run check"
                onChange={(event) => setDraft(event.currentTarget.value)}
                className="h-7 min-w-0 flex-1 rounded-md border border-content/10 bg-transparent px-2 text-[12px] text-content"
              />
              <label className="flex items-center gap-1.5 text-[12px] text-content/75">
                <input
                  type="checkbox"
                  data-memory-draft-local
                  checked={draftLocal}
                  onChange={(event) =>
                    setDraftLocal(event.currentTarget.checked)
                  }
                />
                Local only
              </label>
              <button
                type="button"
                data-memory-add
                disabled={!draft.trim()}
                className="h-7 rounded-md bg-content/8 px-2.5 text-[12px] text-content hover:bg-content/14 disabled:opacity-40"
                onClick={() => {
                  const fact = draft;
                  setDraft("");
                  run(addProjectMemory(project, fact, { local: draftLocal }));
                }}
              >
                Remember
              </button>
            </div>
            <p className={NOTE}>
              Until MonoCode can tell a local session for sure, only a session
              it calls local gets local-only entries; everything else is treated
              as hosted.
            </p>
          </section>
        </>
      )}
      {error ? (
        <p data-memory-error className="text-[12px] text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
