import { useCallback, useEffect, useState } from "react";
import { ContextFileConflict, type ContextFile } from "../model/projectContext";
import { CHARS_PER_TOKEN } from "../../session-preamble/model/preamble";

const NOTE = "text-[11px] leading-4 text-content/45";

/**
 * One text file MonoCode keeps outside the repository, edited in place:
 * global instructions or a project's private notes. A save names the hash it
 * was loaded at, so another window's edit is never overwritten.
 */
export function ContextTextCard({
  id,
  title,
  hint,
  placeholder,
  load,
  save,
}: {
  id: string;
  title: string;
  hint: string;
  placeholder: string;
  load: () => Promise<ContextFile>;
  save: (text: string, expectedHash: string) => Promise<string>;
}) {
  const [loaded, setLoaded] = useState<ContextFile>();
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string>();
  const reload = useCallback(() => {
    setStatus(undefined);
    load()
      .then((file) => {
        setLoaded(file);
        setDraft(file.text ?? "");
      })
      .catch((error) => setStatus(`Could not read it: ${String(error)}`));
  }, [load]);
  useEffect(reload, [reload]);
  const dirty = !!loaded && draft !== (loaded.text ?? "");
  return (
    <section
      data-setting-id={id}
      id={`setting-${id}`}
      className="flex flex-col gap-1.5"
    >
      <h3 className="text-[13px] font-medium text-content">{title}</h3>
      <p className={NOTE}>{hint}</p>
      <textarea
        data-context-text={id}
        value={draft}
        placeholder={placeholder}
        disabled={!loaded}
        onChange={(event) => setDraft(event.currentTarget.value)}
        rows={6}
        className="min-h-24 w-full resize-y rounded-md border border-content/10 bg-transparent p-2 font-mono text-[12px] text-content focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-context-save={id}
          disabled={!dirty}
          className="h-7 rounded-md bg-content/8 px-2.5 text-[12px] text-content hover:bg-content/14 disabled:opacity-40"
          onClick={() => {
            if (!loaded) return;
            save(draft, loaded.hash)
              .then((hash) => {
                setLoaded({ text: draft, hash });
                setStatus("Saved. Sessions get it with their next message.");
              })
              .catch((error) =>
                setStatus(
                  error instanceof ContextFileConflict
                    ? "It changed in another window. Reload to see it, then save again."
                    : `Not saved: ${String(error)}`,
                ),
              );
          }}
        >
          Save
        </button>
        {status?.startsWith("It changed") ? (
          <button
            type="button"
            className="h-7 rounded-md px-2 text-[12px] text-content/70 hover:bg-content/8"
            onClick={reload}
          >
            Reload
          </button>
        ) : null}
        <span className={NOTE}>
          {draft.length.toLocaleString("en-US")} characters, about{" "}
          {Math.ceil(draft.length / CHARS_PER_TOKEN).toLocaleString("en-US")}{" "}
          tokens
        </span>
      </div>
      {status ? (
        <p data-context-status={id} className={NOTE}>
          {status}
        </p>
      ) : null}
    </section>
  );
}
