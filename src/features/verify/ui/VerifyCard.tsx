import { useState, useSyncExternalStore } from "react";
import { CheckCircle, CircleAlert, LoaderCircle } from "../../../shared/ui/icons";
import type { Block } from "../../sessions/model/session";
import {
  latestVerify,
  subscribeVerify,
  verifyState,
  verifyVersion,
} from "../model/verifyStore";
import { PASS_NOTE, PASS_TITLE, type VerifyResult } from "../model/verify";

/**
 * #38a: the card under the latest turn when MonoCode checked the preview
 * after it. A failure offers "Send to agent", which posts the report as the
 * next message. Nothing is sent without the click, unless the chat's auto
 * switch is on.
 */
export function VerifyCard({
  sessionId,
  blocks,
  busy,
  onSend,
}: {
  sessionId: string;
  blocks: readonly Block[];
  busy: boolean;
  /** Send the report as the user's next message. True when it went. */
  onSend: (text: string) => boolean | void;
}) {
  useSyncExternalStore(subscribeVerify, verifyVersion, verifyVersion);
  const result = latestVerify(sessionId, blocks);
  const checking = verifyState(sessionId).checking === true;
  if (!result && !checking) return null;
  return (
    <VerifyCardView result={result} checking={checking} busy={busy} onSend={onSend} />
  );
}

export function VerifyCardView({
  result,
  checking,
  busy,
  onSend,
}: {
  result: VerifyResult | undefined;
  checking: boolean;
  busy: boolean;
  onSend: (text: string) => boolean | void;
}) {
  const [sent, setSent] = useState<string | null>(null);
  if (!result)
    return (
      <div className="px-4 pt-1 pb-2" data-verify-card="checking">
        <div className="flex items-center gap-2 text-[12px] text-content/55">
          <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.75} />
          Checking the preview…
        </div>
      </div>
    );
  const failed = result.checks.filter((check) => !check.ok);
  return (
    <div className="px-4 pt-1 pb-2" data-verify-card={result.ok ? "pass" : "fail"}>
      <div
        className={`flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-[12px] ${
          result.ok
            ? "border-content/10 bg-content/3"
            : "border-red-500/25 bg-red-500/5"
        }`}
      >
        <div className="flex items-center gap-2">
          {result.ok ? (
            <CheckCircle className="size-3.5 text-emerald-500" strokeWidth={1.75} />
          ) : (
            <CircleAlert className="size-3.5 text-red-500" strokeWidth={1.75} />
          )}
          <span className="font-medium text-content/85">
            {result.ok ? PASS_TITLE : "Preview check failed"}
          </span>
          {checking ? (
            <LoaderCircle className="size-3 animate-spin text-content/40" strokeWidth={1.75} />
          ) : null}
        </div>
        {result.ok ? (
          <p className="text-[11.5px] text-content/50">
            {result.scriptsChecked?.length
              ? `The changed scripts parse: ${result.scriptsChecked.join(", ")}. `
              : ""}
            {PASS_NOTE}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5 text-[11.5px] text-content/70">
            {failed.map((check) => (
              <li key={check.id}>{check.detail}</li>
            ))}
            {result.errorLines.slice(-3).map((line) => (
              <li key={line} className="truncate font-mono text-[11px] text-content/55" title={line}>
                {line}
              </li>
            ))}
          </ul>
        )}
        {!result.ok ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || sent === result.turnKey + result.at}
              data-verify-send
              className="h-6.5 rounded-md bg-content px-2.5 text-[11.5px] font-medium text-background-base hover:bg-content/90 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => {
                if (onSend(result.report) !== false) setSent(result.turnKey + result.at);
              }}
            >
              {sent === result.turnKey + result.at ? "Sent" : "Send to agent"}
            </button>
            <span className="text-[11px] text-content/40">
              Sends a report of {result.report.length} characters.
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
