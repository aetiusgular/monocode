import { useState } from "react";
import {
  newProviderAccount,
  removeProviderAccount,
  saveProviderAccount,
} from "../../providers/model/providerAccounts";
import { urlHost } from "../model/loopback";
import {
  checkDraft,
  detectModelServers,
  draftFromDetected,
  emptyDraft,
  entryFromDraft,
  kindIsHosted,
  KIND_LABEL,
  writeCodexHome,
  type DetectedServer,
  type SetupDraft,
} from "../model/modelSetup";
import {
  removeModelProvider,
  saveModelProvider,
  useModelProviders,
  type ModelProviderKind,
} from "../model/modelProviders";
import { providerLocality } from "../model/providerLocality";

const NOTE = "text-[11px] leading-4 text-content/45";
const FIELD =
  "h-7 rounded-md border border-content/10 bg-transparent px-2 text-[12px] text-content";
const BUTTON =
  "h-7 rounded-md border border-content/10 px-2 text-[12px] text-content/80 hover:bg-content/8 disabled:opacity-40";

const KINDS: ModelProviderKind[] = [
  "ollama",
  "llamacpp",
  "lmstudio",
  "vllm",
  "rented",
  "openrouter",
  "custom",
];

export function LocalityBadge({ local }: { local: boolean }) {
  return (
    <span
      className={
        local
          ? "shrink-0 rounded px-1 text-[10px] text-emerald-500 ring-1 ring-emerald-500/30"
          : "shrink-0 rounded px-1 text-[10px] text-amber-500 ring-1 ring-amber-500/30"
      }
      data-locality={local ? "local" : "hosted"}
    >
      {local ? "Local" : "Hosted, not private"}
    </span>
  );
}

/**
 * Settings, Models: add a model provider. Each one gets its own named Codex
 * account, and the screen writes that account's `config.toml` (analytics
 * off), `catalog.json` and instructions file. A local server is found on
 * loopback only. No key is written anywhere.
 */
export function ModelSetupSection() {
  const providers = useModelProviders();
  const [draft, setDraft] = useState<SetupDraft | null>(null);
  const [detected, setDetected] = useState<DetectedServer[] | null>(null);
  const [busy, setBusy] = useState<"detect" | "save" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const check = draft ? checkDraft(draft) : null;
  const update = (patch: Partial<SetupDraft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  const detect = async () => {
    setBusy("detect");
    setMessage(null);
    try {
      setDetected(await detectModelServers());
    } catch (error) {
      setDetected([]);
      setMessage(`Detection failed: ${String(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!draft || !check?.ok) return;
    setBusy("save");
    setMessage(null);
    const account = newProviderAccount(
      "codex",
      draft.label.trim() || KIND_LABEL[draft.kind],
    );
    saveProviderAccount(account);
    try {
      const written = await writeCodexHome(account.id, draft, check);
      saveModelProvider(entryFromDraft(account.id, draft, check));
      setMessage(
        `Wrote ${written.files.length} files to ${written.dir}.` +
          (written.backup ? ` Kept the old config as ${written.backup}.` : "") +
          " Pick this account for a project to use it.",
      );
      setDraft(null);
    } catch (error) {
      removeProviderAccount("codex", account.id);
      setMessage(`Not saved: ${String(error)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-2" data-model-setup>
      <h3 className="text-[12px] font-medium text-content/80">
        Model providers
      </h3>
      <p className={NOTE}>
        Each provider gets its own Codex account and home, so a local home never
        holds a hosted provider or an OpenAI login. Servers are found on this
        Mac only. Whether a named account works without an OpenAI login is not
        tested yet; your wrapper script keeps working either way.
      </p>

      {providers.length ? (
        <ul className="flex flex-col gap-1.5">
          {providers.map((entry) => {
            const local = providerLocality(entry.id) === "local";
            return (
              <li
                key={entry.id}
                className="flex min-w-0 items-center gap-2 rounded-lg border border-content/10 px-2.5 py-1.5 text-[12px]"
                data-model-provider={entry.id}
              >
                <span className="truncate text-content" title={entry.id}>
                  {entry.label}
                </span>
                <LocalityBadge local={local} />
                <span className="truncate text-content/45">
                  {[entry.model, urlHost(entry.baseUrl)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <button
                  type="button"
                  className="ml-auto shrink-0 rounded-md px-1.5 text-[11px] text-content/45 hover:bg-content/8"
                  onClick={() => removeModelProvider(entry.id)}
                  title="Removes it from this list. The account and its folder stay."
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={BUTTON}
          disabled={busy !== null}
          onClick={detect}
        >
          {busy === "detect" ? "Looking…" : "Find servers on this Mac"}
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={busy !== null}
          onClick={() => setDraft(emptyDraft())}
        >
          Add a provider
        </button>
      </div>

      {detected ? (
        detected.length ? (
          <ul className="flex flex-col gap-1" data-detected-servers>
            {detected.map((server) => (
              <li
                key={server.baseUrl}
                className="flex items-center gap-2 text-[12px] text-content/70"
              >
                <span>{KIND_LABEL[server.kind]}</span>
                <span className="text-content/40">{server.baseUrl}</span>
                <span className="text-content/40">
                  {server.models.length} models
                </span>
                <button
                  type="button"
                  className={BUTTON}
                  onClick={() => setDraft(draftFromDetected(server))}
                >
                  Use
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className={NOTE}>
            No server answered on 11434, 1234, 8080 or 8000.
          </p>
        )
      ) : null}

      {draft ? (
        <form
          className="flex flex-col gap-2 rounded-lg border border-content/10 p-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          data-model-setup-form
        >
          <div className="flex flex-wrap gap-2">
            <label className="flex items-center gap-1.5 text-[12px] text-content/60">
              Server
              <select
                className={FIELD}
                value={draft.kind}
                onChange={(event) =>
                  setDraft({
                    ...emptyDraft(event.target.value as ModelProviderKind),
                    model: draft.model,
                    instructions: draft.instructions,
                  })
                }
              >
                {KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_LABEL[kind]}
                  </option>
                ))}
              </select>
            </label>
            <input
              aria-label="Name"
              className={FIELD}
              value={draft.label}
              onChange={(event) => update({ label: event.target.value })}
            />
            <input
              aria-label="Provider id"
              className={FIELD}
              value={draft.providerId}
              onChange={(event) => update({ providerId: event.target.value })}
            />
          </div>
          <input
            aria-label="Base URL"
            className={FIELD}
            value={draft.baseUrl}
            onChange={(event) => update({ baseUrl: event.target.value })}
          />
          <div className="flex flex-wrap gap-2">
            <input
              aria-label="Model"
              placeholder="qwen2.5:7b"
              className={`${FIELD} min-w-48 flex-1`}
              value={draft.model}
              list="model-setup-models"
              onChange={(event) => update({ model: event.target.value })}
            />
            <datalist id="model-setup-models">
              {(detected ?? [])
                .filter((server) => server.baseUrl === draft.baseUrl)
                .flatMap((server) => server.models)
                .map((model) => (
                  <option key={model} value={model} />
                ))}
            </datalist>
            <input
              aria-label="Context window"
              placeholder="16384"
              className={`${FIELD} w-24`}
              value={draft.contextWindow}
              onChange={(event) =>
                update({ contextWindow: event.target.value })
              }
            />
            {kindIsHosted(draft.kind) || draft.envKey ? (
              <input
                aria-label="Key variable"
                placeholder="OPENROUTER_API_KEY"
                className={`${FIELD} w-48`}
                value={draft.envKey}
                onChange={(event) => update({ envKey: event.target.value })}
              />
            ) : null}
          </div>
          <details>
            <summary className="cursor-pointer text-[12px] text-content/60">
              Instructions file
            </summary>
            <textarea
              aria-label="Instructions"
              className="mt-1 h-40 w-full rounded-md border border-content/10 bg-transparent p-2 font-mono text-[11px] text-content"
              value={draft.instructions}
              onChange={(event) => update({ instructions: event.target.value })}
            />
          </details>
          {check && !check.ok ? (
            <p className="text-[11px] text-red-500">{check.error}</p>
          ) : check?.ok ? (
            check.local ? (
              <p className={NOTE}>Local: prompts and code stay on this Mac.</p>
            ) : (
              <p className="text-[11px] text-amber-500" data-not-private>
                Not private. Prompts and code go to{" "}
                {urlHost(check.baseUrl) ?? "this server"}
                {draft.kind === "rented"
                  ? ", a machine you do not own, even through a tunnel"
                  : ""}
                . Use a throwaway repository.
                {check.envKey
                  ? ` The key stays in ${check.envKey} and is not written.`
                  : ""}
              </p>
            )
          ) : null}
          <div className="flex gap-2">
            <button
              type="submit"
              className={BUTTON}
              disabled={!check?.ok || busy !== null}
            >
              {busy === "save" ? "Writing…" : "Write Codex home"}
            </button>
            <button
              type="button"
              className={BUTTON}
              onClick={() => setDraft(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {message ? <p className={NOTE}>{message}</p> : null}
    </section>
  );
}
