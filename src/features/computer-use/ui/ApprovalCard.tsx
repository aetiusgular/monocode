import { useState } from "react";
import { AlertCircle, AppWindow } from "../../../shared/ui/icons";
import type { LocalitySession } from "../../server-locality/model/locality";
import { cardText } from "../model/card";
import type { AppInfo } from "../model/client";

/**
 * The approval card for one app in one chat (C2, C5). Every string is
 * rendered as text. The agent's reason is shown as its words, in quotes.
 */
export function ApprovalCard({
  app,
  reason,
  refusal,
  session,
  withoutVision,
  onAllow,
  onDeny,
}: {
  app: AppInfo | undefined;
  reason?: string;
  refusal?: string;
  session: LocalitySession;
  withoutVision?: boolean;
  onAllow: () => Promise<string | undefined>;
  onDeny: () => Promise<string | undefined>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const text = app
    ? cardText({ app, reason, session, withoutVision })
    : undefined;
  const act = async (fn: () => Promise<string | undefined>) => {
    setBusy(true);
    setError(await fn());
    setBusy(false);
  };
  return (
    <div
      role="alertdialog"
      aria-label={text?.title ?? "Computer use request"}
      data-computer-use-card
      className="pointer-events-auto w-full max-w-md rounded-xl border border-content/15 bg-background-base/95 p-3 text-[13px] text-content shadow-xl backdrop-blur-xl"
    >
      <div className="flex items-start gap-2">
        <AppWindow className="mt-0.5 size-4 shrink-0 text-content/60" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="font-medium">{text?.title ?? "Computer use request"}</p>
          {text ? (
            <p className="truncate font-mono text-[11px] text-content/60">
              {text.app}
            </p>
          ) : null}
          {text?.reason ? (
            <p className="text-content/70">
              The agent says: “{text.reason}”
            </p>
          ) : null}
          {text?.warning ? (
            <p className="flex gap-1.5 rounded-md bg-amber-400/10 px-2 py-1.5 text-amber-400">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <span>{text.warning}</span>
            </p>
          ) : null}
          {text ? <p className="text-content/70">{text.scope}</p> : null}
          {text ? <p className="text-content/70">{text.screen}</p> : null}
          {text?.vision ? (
            <p className="text-content/70">{text.vision}</p>
          ) : null}
          {refusal ? <p className="text-red-400">{refusal}</p> : null}
          {error ? <p className="text-red-400">{error}</p> : null}
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(onDeny)}
          className="rounded-md border border-content/15 px-2.5 py-1 text-[12px] hover:bg-content/5 disabled:opacity-50"
        >
          {text?.deny ?? "Deny"}
        </button>
        {app && !refusal ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(onAllow)}
            className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {text?.allow ?? "Allow for this chat"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
