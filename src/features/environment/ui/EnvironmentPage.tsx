import { useCallback, useEffect, useState } from "react";
import type { RecentProject } from "../../projects/model/recents";
import { projectName } from "../../../shared/lib/paths";
import { HARNESSES, HARNESS_TITLE } from "../../sessions/model/session";
import {
  ProjectChoice,
  useProjectChoice,
} from "../../project-context/ui/ProjectChoice";
import {
  envNameProblem,
  envNote,
  loadEnv,
  removeEnvVar,
  setEnvVar,
  type EnvVar,
  type EnvView,
} from "../model/envStore";

const NOTE = "text-[11px] leading-4 text-content/45";
const INPUT =
  "h-7 min-w-0 rounded-md border border-content/10 bg-transparent px-2 font-mono text-[12px] text-content";
const BUTTON =
  "h-7 rounded-md bg-content/8 px-2.5 text-[12px] text-content hover:bg-content/14 disabled:opacity-40";

function VarList({
  vars,
  onRemove,
}: {
  vars: EnvVar[];
  onRemove: (name: string) => void;
}) {
  if (!vars.length) return <p className={NOTE}>None.</p>;
  return (
    <div className="flex flex-col gap-1">
      {vars.map((entry) => (
        <div
          key={entry.name}
          data-env-var={entry.name}
          className="flex items-center gap-2 text-[12px]"
        >
          <span className="font-mono text-content/90">{entry.name}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-content/55">
            {entry.secret ? "•••••• in the keychain" : (entry.value ?? "")}
          </span>
          <button
            type="button"
            data-env-remove
            className="h-6.5 rounded-md px-2 text-[11px] text-content/70 hover:bg-content/10"
            onClick={() => onRemove(entry.name)}
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

function AddVar({
  onAdd,
}: {
  onAdd: (name: string, value: string, secret: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [secret, setSecret] = useState(false);
  const problem = name ? envNameProblem(name) : undefined;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <input
          data-env-name
          value={name}
          placeholder="NAME"
          onChange={(event) => setName(event.currentTarget.value.trim())}
          className={`${INPUT} w-44`}
        />
        <input
          data-env-value
          value={value}
          type={secret ? "password" : "text"}
          placeholder="value"
          autoComplete="off"
          onChange={(event) => setValue(event.currentTarget.value)}
          className={`${INPUT} flex-1`}
        />
        <label className="flex items-center gap-1.5 text-[12px] text-content/75">
          <input
            type="checkbox"
            data-env-secret
            checked={secret}
            onChange={(event) => setSecret(event.currentTarget.checked)}
          />
          Secret
        </label>
        <button
          type="button"
          data-env-add
          disabled={!name || !!problem}
          className={BUTTON}
          onClick={() => {
            onAdd(name, value, secret);
            setName("");
            setValue("");
            setSecret(false);
          }}
        >
          Set
        </button>
      </div>
      {problem ? (
        <p data-env-problem className="text-[11px] text-red-600">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/**
 * #28: the environment every harness starts with. Settings, Environment.
 */
export function EnvironmentPage({
  cwd,
  recents = [],
}: {
  cwd: string;
  recents?: RecentProject[];
}) {
  const { projects, project, setProject } = useProjectChoice(cwd, recents);
  const [view, setView] = useState<EnvView>();
  const [error, setError] = useState<string>();
  const refresh = useCallback(() => {
    loadEnv()
      .then((next) => {
        setView(next);
        setError(undefined);
      })
      .catch((cause) =>
        setError(`Could not read the environment: ${String(cause)}`),
      );
  }, []);
  useEffect(refresh, [refresh]);
  const run = (work: Promise<void>) =>
    void work
      .then(refresh)
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );

  return (
    <div data-environment-page className="flex flex-col gap-5">
      <p className={NOTE}>
        Every harness MonoCode starts gets these values, project ones over
        global ones. The agent can read any of them, and a value can end up in
        the model&apos;s context, so keep to what the work needs. A secret is
        kept in the system keychain and never shown again. Changes reach a chat
        when its harness next starts.
      </p>
      <section
        data-setting-id="environment-global"
        id="setting-environment-global"
        className="flex flex-col gap-2"
      >
        <h3 className="text-[13px] font-medium text-content">Every project</h3>
        <VarList
          vars={view?.global ?? []}
          onRemove={(name) => run(removeEnvVar(undefined, name))}
        />
        <AddVar
          onAdd={(name, value, secret) =>
            run(setEnvVar({ name, value, secret }))
          }
        />
      </section>
      <section
        data-setting-id="environment-project"
        id="setting-environment-project"
        className="flex flex-col gap-2"
      >
        <ProjectChoice
          project={project}
          projects={projects}
          onSelect={setProject}
        />
        {project ? (
          <>
            <h3 className="text-[13px] font-medium text-content">
              {projectName(project)} only
            </h3>
            <p className={NOTE}>Also in its worktrees.</p>
            <VarList
              vars={view?.projects[project] ?? []}
              onRemove={(name) => run(removeEnvVar(project, name))}
            />
            <AddVar
              onAdd={(name, value, secret) =>
                run(setEnvVar({ project, name, value, secret }))
              }
            />
          </>
        ) : (
          <p className={NOTE}>Open a project to set values for it.</p>
        )}
      </section>
      <section
        data-setting-id="environment-harnesses"
        id="setting-environment-harnesses"
        className="flex flex-col gap-1"
      >
        <h3 className="text-[13px] font-medium text-content">
          What reaches each harness&apos;s tools
        </h3>
        {HARNESSES.map((harness) => (
          <p
            key={harness}
            data-env-note={harness}
            className="text-[12px] text-content/70"
          >
            <span className="text-content/90">{HARNESS_TITLE[harness]}:</span>{" "}
            {envNote(harness)}
          </p>
        ))}
      </section>
      {error ? (
        <p data-env-error className="text-[12px] text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
