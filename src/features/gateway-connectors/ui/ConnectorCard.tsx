import { Check, Plus } from "../../../shared/ui/icons";
import { connectorNeeds, type CatalogConnector } from "../model/catalog";
import type { ConnectorStatus, InstalledConnector } from "../model/installed";
import { ConnectorIcon } from "./ConnectorIcon";

export const STATUS_LABEL: Record<ConnectorStatus, string> = {
  ready: "Works",
  "needs-sign-in": "Needs sign-in",
  "needs-setup": "Needs setup",
  untested: "Not tested yet",
  failed: "Failed",
};

export const WAITING_FOR_SIGN_IN = "Waiting for sign-in in your browser…";

/** The line under a card's description: what it needs, or how it is. */
export function connectorStateLine(
  entry: CatalogConnector,
  connector: InstalledConnector | undefined,
  progress: { testing?: boolean; signingIn?: boolean },
): string {
  if (!connector) return connectorNeeds(entry);
  if (progress.signingIn) return WAITING_FOR_SIGN_IN;
  if (progress.testing) return "Testing…";
  if (connector.status === "ready") {
    const tools = connector.test?.tools ?? 0;
    return `Works · ${tools} ${tools === 1 ? "tool" : "tools"}`;
  }
  if (connector.status === "failed") {
    return `Failed: ${connector.test?.reason ?? "test failed"}`;
  }
  return STATUS_LABEL[connector.status];
}

const STATE_BUTTON =
  "h-7 shrink-0 rounded-md border border-content/10 px-2 text-[12px] text-content/70 hover:bg-content/10 hover:text-content disabled:opacity-50";

/**
 * One connector in the grid. The card opens its detail. The control at its
 * right adds it, or shows its state as a button: a check only once a test
 * has shown it works.
 */
export function ConnectorCard({
  entry,
  connector,
  testing = false,
  signingIn = false,
  busy = false,
  onOpen,
  onAdd,
  onSignIn,
  onSetUp,
  onTest,
  onCancelSignIn,
}: {
  entry: CatalogConnector;
  /** Set when the connector is added. */
  connector?: InstalledConnector;
  testing?: boolean;
  signingIn?: boolean;
  busy?: boolean;
  onOpen: () => void;
  onAdd: () => void;
  onSignIn: () => void;
  onSetUp: () => void;
  onTest: () => void;
  onCancelSignIn: () => void;
}) {
  const title = entry.title;
  let control;
  if (!connector) {
    control = (
      <button
        type="button"
        aria-label={`Add ${title}`}
        title="Add"
        disabled={busy}
        onClick={onAdd}
        className="grid size-7 shrink-0 place-items-center rounded-md border border-content/10 text-content/60 hover:bg-content/10 hover:text-content disabled:opacity-40"
      >
        <Plus className="size-4" strokeWidth={2} />
      </button>
    );
  } else if (signingIn) {
    control = (
      <button
        type="button"
        aria-label={`Cancel sign-in for ${title}`}
        onClick={onCancelSignIn}
        className={STATE_BUTTON}
      >
        Cancel
      </button>
    );
  } else if (testing) {
    control = (
      <button type="button" disabled className={STATE_BUTTON}>
        Testing…
      </button>
    );
  } else if (connector.status === "ready") {
    control = (
      <span
        role="img"
        aria-label={`${title} works`}
        title="Tested and working"
        className="grid size-7 shrink-0 place-items-center rounded-md text-content/60"
      >
        <Check className="size-4" strokeWidth={2} />
      </span>
    );
  } else {
    const [label, action] =
      connector.status === "needs-sign-in"
        ? ["Sign in", onSignIn]
        : connector.status === "needs-setup"
          ? ["Set up", onSetUp]
          : connector.status === "failed"
            ? ["Failed", onOpen]
            : ["Test", onTest];
    control = (
      <button
        type="button"
        aria-label={`${label}: ${title}`}
        disabled={busy}
        onClick={action}
        className={`${STATE_BUTTON} ${connector.status === "failed" ? "text-red-400 hover:text-red-400" : ""}`}
      >
        {label}
      </button>
    );
  }
  const line = connectorStateLine(entry, connector, { testing, signingIn });
  return (
    <li
      className="flex min-w-0 items-center gap-2 rounded-lg border border-content/10 p-2.5 hover:border-content/20 hover:bg-content/[0.03]"
      data-connector-card={entry.name}
      data-connector-state={
        !connector
          ? "not-added"
          : signingIn
            ? "signing-in"
            : testing
              ? "testing"
              : connector.status
      }
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${title} details`}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ConnectorIcon title={title} icon={entry.icon} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-content">
            {title}
          </span>
          <span
            className="block truncate text-[12px] text-content/50"
            title={entry.description}
          >
            {entry.description || entry.name}
          </span>
          <span
            className={`block truncate text-[11px] ${connector?.status === "failed" && !testing ? "text-red-400/80" : "text-content/35"}`}
            title={line}
          >
            {line}
          </span>
        </span>
      </button>
      {control}
    </li>
  );
}
