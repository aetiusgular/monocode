import {
  describeServerLocality,
  localityExplanation,
  localityLabel,
  type LocalityServer,
} from "../model/serverLocality";
import {
  serverMark,
  setServerMark,
  useServerMarksVersion,
  type ServerMark,
} from "../model/serverMarks";

/** Not marked, then local, then hosted, then not marked again. */
export function nextServerMark(current: ServerMark | undefined): ServerMark | undefined {
  if (current === undefined) return "local";
  if (current === "local") return "hosted";
  return undefined;
}

const TONE = {
  local: "text-emerald-400",
  hosted: "text-amber-400",
  unknown: "text-content/40",
} as const;

/**
 * A server's local or hosted mark (#9). A click cycles your mark: local,
 * hosted, then back to the app's own reading. "Not marked" counts as hosted.
 */
export function ServerLocalityTag({
  server,
  editable = true,
}: {
  server: LocalityServer;
  editable?: boolean;
}) {
  useServerMarksVersion();
  const result = describeServerLocality(server);
  const label = localityLabel(result);
  const mark = serverMark(server.name);
  const explanation = localityExplanation(result);
  const className = `shrink-0 rounded px-1 text-[10px] font-medium uppercase tracking-wide ${TONE[result.locality]}`;
  if (!editable) {
    return (
      <span data-server-locality={result.locality} title={explanation} className={className}>
        {label}
      </span>
    );
  }
  const next = nextServerMark(mark);
  const action =
    next === "local"
      ? "Click to mark it local."
      : next === "hosted"
        ? "Click to mark it hosted."
        : "Click to clear your mark.";
  return (
    <button
      type="button"
      data-server-locality={result.locality}
      aria-label={`${server.name}: ${label}. ${action}`}
      title={`${explanation} ${action}`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        setServerMark(server.name, next);
      }}
      className={`${className} hover:bg-content/10`}
    >
      {label}
    </button>
  );
}
