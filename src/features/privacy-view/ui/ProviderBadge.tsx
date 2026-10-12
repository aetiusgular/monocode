import { useRef, useState } from "react";
import { Popover } from "../../../shared/ui/Popover";
import {
  BUILT_IN_PROVIDERS,
  useModelProviders,
} from "../../model-setup/model/modelProviders";
import { providerLocality } from "../../model-setup/model/providerLocality";
import {
  sessionModelProvider,
  sessionProviderLabel,
  type SessionProviderInput,
} from "../../model-setup/model/sessionProvider";
import { urlHost } from "../../model-setup/model/loopback";
import type { Locality } from "../../server-locality/model/locality";
import { harnessCan } from "../../../integrations/harness/core/capabilities";

export type ProviderChoice = {
  id: string;
  label: string;
  host?: string;
  locality: Locality;
};

/** Providers a Codex chat can pick: yours, then Codex's built-ins. */
export function providerChoices(
  entries: ReturnType<typeof useModelProviders>,
): ProviderChoice[] {
  const seen = new Set<string>();
  const choices: ProviderChoice[] = [];
  for (const entry of entries) {
    seen.add(entry.id);
    choices.push({
      id: entry.id,
      label: entry.label,
      host: urlHost(entry.baseUrl),
      locality: providerLocality(entry.id),
    });
  }
  for (const [id, builtIn] of Object.entries(BUILT_IN_PROVIDERS)) {
    if (seen.has(id)) continue;
    choices.push({
      id,
      label: builtIn.label,
      host: urlHost(builtIn.baseUrl),
      locality: providerLocality(id),
    });
  }
  return choices;
}

const LOCALITY_TEXT: Record<Locality, string> = {
  local: "Local",
  hosted: "Hosted",
  unknown: "Not known, counted as hosted",
};

function LocalityDot({ locality }: { locality: Locality }) {
  return (
    <span
      aria-hidden
      className={`size-1.5 shrink-0 rounded-full ${
        locality === "local" ? "bg-emerald-500" : "bg-amber-500"
      }`}
    />
  );
}

/**
 * The model provider next to the model in a Codex composer, with a local or
 * hosted mark, and a menu to set the provider for this chat. The provider is
 * fixed when the thread opens, so a change reopens it on the next turn.
 */
export function ProviderBadge({
  session,
  onChange,
}: {
  session: SessionProviderInput;
  onChange?: (providerId: string) => void;
}) {
  const entries = useModelProviders();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  if (!harnessCan(session.harness, "modelProvider")) return null;
  const current = sessionModelProvider(session);
  const locality = providerLocality(current);
  const label = sessionProviderLabel(session) ?? "Home default";

  return (
    <div ref={root} className="relative" data-provider-badge>
      <button
        type="button"
        disabled={!onChange}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Model provider: ${label}. ${LOCALITY_TEXT[locality]}.`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((value) => !value)}
        className="flex h-6.5 max-w-40 items-center gap-1.5 rounded-md bg-selection px-1.5 text-[11px] text-content hover:bg-selection-hover disabled:cursor-default"
        data-locality={locality}
      >
        <LocalityDot locality={locality} />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {open && onChange ? (
        <Popover
          anchor={root}
          side="top"
          width={260}
          autoFocus
          onDismiss={() => setOpen(false)}
          role="listbox"
          aria-label="Model provider"
          className="p-1"
        >
          <ProviderOption
            label="Home default"
            note="What this Codex home's config names"
            locality={providerLocality(undefined)}
            selected={!session.modelProvider}
            onPick={() => {
              onChange("");
              setOpen(false);
            }}
          />
          {providerChoices(entries).map((choice) => (
            <ProviderOption
              key={choice.id}
              label={choice.label}
              note={choice.host}
              locality={choice.locality}
              selected={session.modelProvider === choice.id}
              onPick={() => {
                onChange(choice.id);
                setOpen(false);
              }}
            />
          ))}
          <p className="px-2 py-1.5 text-[11px] leading-4 text-content/50">
            Codex must have this provider in the chat's home. Set one up in
            Settings, Models. A change applies from the next turn.
          </p>
        </Popover>
      ) : null}
    </div>
  );
}

function ProviderOption({
  label,
  note,
  locality,
  selected,
  onPick,
}: {
  label: string;
  note?: string;
  locality: Locality;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPick}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] ${
        selected
          ? "bg-selection text-content"
          : "text-content hover:bg-content/5"
      }`}
    >
      <LocalityDot locality={locality} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-[10px] text-content/45">
        {note ? `${note} · ` : ""}
        {LOCALITY_TEXT[locality]}
      </span>
    </button>
  );
}
