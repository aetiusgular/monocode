import { useLayoutEffect, useRef } from "react";
import type { ToolCallDetail } from "../model/toolCallDetail";

const BOX =
  "min-w-0 rounded-lg border border-content/8 bg-content/[0.035] px-2.5 py-2";
const HEADING = "pb-1 font-sans text-[11px] font-medium text-content/45";
const TEXT =
  "max-h-64 min-w-0 overflow-auto overscroll-contain whitespace-pre-wrap break-words font-mono text-[12px] leading-5";

/**
 * What a call asked for and what came back, under the row it belongs to. The
 * response keeps a height of its own and scrolls inside it, so a long log does
 * not push the rest of the work off the screen. While the call runs, the log
 * stays on its latest line unless the viewer has scrolled up to read.
 */
export function ToolCallDetailView({
  detail,
  indent = false,
}: {
  detail: ToolCallDetail;
  indent?: boolean;
}) {
  const { request, response, running, stopped, cut, latest } = detail;
  // A call cut off by Stop has no response, only what it printed until then.
  const heading = running
    ? "Output so far"
    : stopped && response
      ? "Output before it stopped"
      : "Response";
  const log = useRef<HTMLPreElement | null>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const el = log.current;
    if (el && running && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [response, running]);
  return (
    <div
      data-tool-call-detail={
        running ? "running" : stopped ? "stopped" : "settled"
      }
      className={`flex min-w-0 flex-col gap-1.5 pb-1.5 pt-0.5 ${indent ? "pl-5" : ""}`}
    >
      <section aria-label="Request" className={BOX}>
        <h5 className={HEADING}>Request</h5>
        <pre className={`${TEXT} text-content/80`}>{request}</pre>
      </section>
      <section aria-label={heading} className={BOX}>
        <h5 className={HEADING}>{heading}</h5>
        {response ? (
          <pre
            ref={log}
            data-tool-call-response
            className={`${TEXT} text-content/65`}
            onScroll={(event) => {
              const el = event.currentTarget;
              atEnd.current =
                el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
            }}
          >
            {response}
          </pre>
        ) : (
          <p className="font-sans text-[12px] text-content/40">
            {running
              ? "Nothing printed yet."
              : stopped
                ? "Stopped before it returned anything."
                : "No output."}
          </p>
        )}
        {cut ? (
          <p className="pt-1 font-sans text-[11px] text-content/40">
            {latest
              ? "Showing the last 8,000 characters."
              : "Cut to the first 8,000 characters."}
          </p>
        ) : null}
      </section>
    </div>
  );
}
