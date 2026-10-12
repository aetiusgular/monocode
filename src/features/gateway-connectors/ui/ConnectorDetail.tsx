import { ConnectorToolsSection } from "./ConnectorTools";
import { useEffect, useRef, useState } from "react";
import { Modal } from "../../../shared/ui/Modal";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import { ExternalLink, Plus } from "../../../shared/ui/icons";
import {
  connectorNeeds,
  type CatalogConnector,
  type ConnectorSetting,
} from "../model/catalog";
import type { InstalledConnector } from "../model/installed";
import { ConnectorIcon } from "./ConnectorIcon";
import { connectorStateLine, WAITING_FOR_SIGN_IN } from "./ConnectorCard";

export type ConnectorActions = {
  add: (entry: CatalogConnector) => Promise<unknown>;
  remove: (
    connector: InstalledConnector,
    options: { signOut: boolean },
  ) => Promise<void>;
  saveSetup: (
    connector: InstalledConnector,
    values: { config: Record<string, string>; secrets: Record<string, string> },
  ) => Promise<void>;
  signIn: (connector: InstalledConnector) => Promise<unknown>;
  cancelSignIn: (connector: InstalledConnector) => void;
  signOut: (connector: InstalledConnector) => Promise<void>;
  test: (connector: InstalledConnector) => Promise<void>;
};

const NO_CONFIG: Record<string, string> = {};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const INPUT =
  "h-7 min-w-0 rounded-md border border-content/10 bg-transparent px-2 text-[12px] text-content outline-none placeholder:text-content/35 focus:border-content/25";

function SettingField({
  setting,
  value,
  onChange,
}: {
  setting: ConnectorSetting;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-[12px] text-content/70">
        {setting.name}
        {setting.required ? "" : " (optional)"}
      </span>
      <input
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={setting.name}
        className={INPUT}
      />
      {setting.description ? (
        <span className="text-[11px] leading-4 text-content/40">
          {setting.description}
        </span>
      ) : null}
    </label>
  );
}

/**
 * One connector in full: its state, the setup it needs (sign-in, settings,
 * keys), the last test with its raw output, and add or remove. Key values
 * are typed into password fields, handed to Docker on stdin, and cleared;
 * MonoCode never shows or keeps them.
 */
export function ConnectorDetail({
  entry,
  connector,
  config = NO_CONFIG,
  testing = false,
  signingIn = false,
  focusSetup = false,
  actions,
  onClose,
}: {
  entry: CatalogConnector;
  connector?: InstalledConnector;
  /** The connector's config values as Docker reports them. */
  config?: Record<string, string>;
  testing?: boolean;
  signingIn?: boolean;
  /** Opened right after adding: focus the first setup field. */
  focusSetup?: boolean;
  actions: ConnectorActions;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>(config);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [signOutOnRemove, setSignOutOnRemove] = useState(true);
  // Docker's values arrive after the sheet opens; fill only untouched fields.
  const touched = useRef(new Set<string>());
  useEffect(() => {
    setValues((current) => {
      const next = { ...current };
      for (const [key, value] of Object.entries(config)) {
        if (!touched.current.has(key)) next[key] = value;
      }
      return next;
    });
  }, [config]);

  // After the sheet's own focus on its close button: opened right after
  // adding, the first setup field takes focus instead.
  const form = useRef<HTMLFormElement>(null);
  const hasSetup = !!connector;
  useEffect(() => {
    if (!focusSetup || !hasSetup) return;
    const timer = setTimeout(() =>
      form.current?.querySelector("input")?.focus(),
    );
    return () => clearTimeout(timer);
  }, [focusSetup, hasSetup]);

  const run = (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    void action()
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(null));
  };

  const settings = connector?.settings.length
    ? connector.settings
    : entry.settings;
  const secretNames = connector?.secrets.length
    ? connector.secrets
    : entry.secrets;
  const required = settings.filter((setting) => setting.required);
  const optional = settings.filter((setting) => !setting.required);
  const missingSecrets = new Set(connector?.missingSecrets ?? secretNames);
  const hasForm =
    !!connector && (settings.length > 0 || secretNames.length > 0);
  const working = busy !== null || testing || signingIn;

  const save = () => {
    if (!connector) return;
    for (const setting of required) {
      if (!(values[setting.key] ?? "").trim()) {
        setError(`Fill in ${setting.name}.`);
        return;
      }
    }
    for (const name of secretNames) {
      if (missingSecrets.has(name) && !secrets[name]) {
        setError(`Paste a value for ${name}.`);
        return;
      }
    }
    const changed = Object.fromEntries(
      Object.entries(values).filter(
        ([key, value]) =>
          settings.some((setting) => setting.key === key) &&
          value.trim() &&
          value !== config[key],
      ),
    );
    const typed = Object.fromEntries(
      Object.entries(secrets).filter(([, value]) => value),
    );
    // Cleared right away: a key lives only in this call.
    setSecrets({});
    run("save", () =>
      actions.saveSetup(connector, { config: changed, secrets: typed }),
    );
  };

  const test = connector?.test;
  return (
    <Modal title={entry.title} description={entry.name} onClose={onClose}>
      <div className="flex flex-col gap-4 px-4 pt-2 pb-4" data-connector-detail>
        <div className="flex items-start gap-3">
          <ConnectorIcon title={entry.title} icon={entry.icon} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] leading-relaxed text-content/70">
              {entry.description || "No description in the catalog."}
            </p>
            <p className="mt-1 text-[12px] text-content/45">
              {entry.kind === "remote" ? "Hosted" : "Runs in Docker"} ·{" "}
              {connector
                ? connectorStateLine(entry, connector, { testing, signingIn })
                : connectorNeeds(entry)}
            </p>
          </div>
        </div>

        {error ? (
          <p role="alert" className="text-[12px] text-red-400">
            {error}
          </p>
        ) : null}

        {connector && entry.auth === "oauth" ? (
          <section aria-label="Sign in" className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-[12px] text-content/55">
              {signingIn
                ? WAITING_FOR_SIGN_IN
                : connector.setup === "needs-sign-in"
                  ? "Sign in once. Docker keeps the token for every chat."
                  : "Signed in through Docker."}
            </p>
            {signingIn ? (
              <SecondaryButton onClick={() => actions.cancelSignIn(connector)}>
                Cancel
              </SecondaryButton>
            ) : connector.setup === "needs-sign-in" ? (
              <SecondaryButton
                disabled={working}
                onClick={() => run("sign-in", () => actions.signIn(connector))}
              >
                Sign in
              </SecondaryButton>
            ) : (
              <SecondaryButton
                disabled={working}
                onClick={() =>
                  run("sign-out", () => actions.signOut(connector))
                }
              >
                Sign out
              </SecondaryButton>
            )}
          </section>
        ) : null}

        {hasForm ? (
          <form
            ref={form}
            aria-label="Set up"
            className="flex flex-col gap-3 rounded-lg border border-content/10 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <p className="text-[12px] font-medium text-content/70">Set up</p>
            {required.map((setting) => (
              <SettingField
                key={setting.key}
                setting={setting}
                value={values[setting.key] ?? ""}
                onChange={(value) => {
                  touched.current.add(setting.key);
                  setValues((current) => ({
                    ...current,
                    [setting.key]: value,
                  }));
                }}
              />
            ))}
            {secretNames.map((name) => (
              <label key={name} className="flex min-w-0 flex-col gap-1">
                <span className="truncate font-mono text-[11px] text-content/55">
                  {name}
                  {missingSecrets.has(name) ? "" : " · saved"}
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={secrets[name] ?? ""}
                  onChange={(event) =>
                    setSecrets((current) => ({
                      ...current,
                      [name]: event.target.value,
                    }))
                  }
                  placeholder={
                    missingSecrets.has(name)
                      ? "Paste the value"
                      : "Saved. Paste a new value to replace it"
                  }
                  aria-label={`Value for ${name}`}
                  className={INPUT}
                />
              </label>
            ))}
            {optional.length > 0 ? (
              <details>
                <summary className="cursor-default text-[12px] text-content/55">
                  More settings
                </summary>
                <div className="mt-2 flex flex-col gap-3">
                  {optional.map((setting) => (
                    <SettingField
                      key={setting.key}
                      setting={setting}
                      value={values[setting.key] ?? ""}
                      onChange={(value) => {
                        touched.current.add(setting.key);
                        setValues((current) => ({
                          ...current,
                          [setting.key]: value,
                        }));
                      }}
                    />
                  ))}
                </div>
              </details>
            ) : null}
            <p className="text-[11px] leading-4 text-content/40">
              Settings are stored in the connector's Docker profile. Keys go to
              Docker's secret store; MonoCode does not keep them.
            </p>
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={working}
                className="rounded-md border border-content/10 px-2.5 py-1 text-[12px] text-content/80 hover:bg-content/10 hover:text-content disabled:opacity-40"
              >
                {busy === "save" || testing ? "Testing…" : "Save and test"}
              </button>
            </div>
          </form>
        ) : null}

        {connector ? (
          <section aria-label="Test" className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <p
                className={`min-w-0 flex-1 text-[12px] ${test && !test.ok ? "text-red-400" : "text-content/55"}`}
              >
                {testing
                  ? "Testing through Docker's gateway…"
                  : test
                    ? test.ok
                      ? `Works: ${test.tools} ${test.tools === 1 ? "tool" : "tools"}. Tested ${new Date(test.at).toLocaleString()}.`
                      : `Failed: ${test.reason ?? "test failed"}. Tested ${new Date(test.at).toLocaleString()}.`
                    : "Not tested yet."}
              </p>
              <SecondaryButton
                disabled={working || connector.setup !== "complete"}
                onClick={() => run("test", () => actions.test(connector))}
              >
                Test
              </SecondaryButton>
            </div>
            {test?.output ? (
              <details>
                <summary className="cursor-default text-[12px] text-content/45">
                  Details
                </summary>
                <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-content/5 p-2 font-mono text-[11px] leading-4 whitespace-pre-wrap text-content/60">
                  {test.output}
                </pre>
              </details>
            ) : null}
          </section>
        ) : null}

        {connector ? (
          <ConnectorToolsSection
            profileId={connector.profileId}
            server={connector.server}
          />
        ) : entry.tools.length > 0 ? (
          <section aria-label="Tools">
            <p className="pb-1 text-[12px] text-content/55">
              {entry.tools.length} {entry.tools.length === 1 ? "tool" : "tools"}{" "}
              in the catalog
            </p>
            <ul className="flex flex-wrap gap-1">
              {entry.tools.map((tool) => (
                <li
                  key={tool}
                  className="rounded bg-content/8 px-1.5 py-0.5 font-mono text-[11px] text-content/60"
                >
                  {tool}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {entry.remoteUrl || entry.image ? (
          <p className="flex items-center gap-1.5 truncate text-[11px] text-content/40">
            <ExternalLink className="size-3 shrink-0" strokeWidth={1.75} />
            <span className="truncate font-mono">
              {entry.remoteUrl ?? entry.image}
            </span>
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2 border-t border-content/10 pt-3">
          {connector ? (
            <>
              {connector.oauthApp ? (
                <label className="mr-auto flex items-center gap-1.5 text-[12px] text-content/55">
                  <input
                    type="checkbox"
                    checked={signOutOnRemove}
                    onChange={(event) =>
                      setSignOutOnRemove(event.target.checked)
                    }
                  />
                  Also sign out
                </label>
              ) : null}
              <SecondaryButton
                danger
                disabled={busy !== null}
                onClick={() =>
                  run("remove", () =>
                    actions.remove(connector, {
                      signOut: signOutOnRemove && !!connector.oauthApp,
                    }),
                  )
                }
              >
                Remove
              </SecondaryButton>
            </>
          ) : (
            <SecondaryButton
              disabled={busy !== null}
              onClick={() => run("add", () => actions.add(entry))}
            >
              <Plus className="size-3.5" strokeWidth={2} />
              {busy === "add" ? "Adding…" : "Add"}
            </SecondaryButton>
          )}
        </div>
      </div>
    </Modal>
  );
}
