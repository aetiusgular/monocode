import { PanelSection } from "../../session-panel/ui/PanelSection";
import type {
  Destination,
  NetworkDecision,
  PrivacyView,
} from "../model/privacyView";
import type { Locality } from "../../server-locality/model/locality";

const ROW =
  "grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-x-1 text-[12px]";

const LOCALITY_LABEL: Record<Locality, string> = {
  local: "Local",
  hosted: "Hosted",
  unknown: "Unknown, counted as hosted",
};

const DECISION_LABEL: Record<
  NonNullable<NetworkDecision["decided"]> | "pending",
  string
> = {
  allow: "Allowed",
  deny: "Denied",
  cancelled: "Cancelled",
  pending: "Waiting",
};

/** The green Private mark, shown only when every route is local. */
export function PrivateBadge({ view }: { view: Pick<PrivacyView, "private"> }) {
  if (!view.private) return null;
  return (
    <span
      data-private-badge
      title="Model, harness home and every enabled tool are on this Mac."
      className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium text-emerald-500 ring-1 ring-emerald-500/30"
    >
      Private
    </span>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className={ROW}>
      <dt className="py-1 text-content/45">{label}</dt>
      <dd className="min-w-0 py-1 text-content/85">{value}</dd>
    </div>
  );
}

function DestinationRow({ item }: { item: Destination }) {
  return (
    <li
      className="flex min-w-0 items-start gap-2 py-1 text-[12px]"
      data-destination={item.kind}
      data-locality={item.locality}
    >
      <span
        aria-hidden
        className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
          item.locality === "local" ? "bg-emerald-500" : "bg-amber-500"
        }`}
      />
      <span className="min-w-0">
        <span className="block truncate text-content/85">{item.label}</span>
        {item.detail ? (
          <span className="block text-[11px] leading-4 text-content/45">
            {item.detail}
          </span>
        ) : null}
      </span>
      <span className="ml-auto shrink-0 text-[10px] text-content/45">
        {LOCALITY_LABEL[item.locality]}
      </span>
    </li>
  );
}

/**
 * Side panel section: the sandbox the session runs in, where its data goes,
 * and the network requests it asked for. It shows what MonoCode and the
 * harness report. It does not replace the firewall, and it does not see what
 * a connector container sends.
 */
export function PrivacySection({ view }: { view: PrivacyView }) {
  const { sandbox } = view;
  return (
    <PanelSection
      title="Sandbox and privacy"
      fold="privacy"
      action={<PrivateBadge view={view} />}
    >
      <div className="flex flex-col gap-2 px-2" data-privacy-section>
        {!sandbox.sandboxed ? (
          <p
            className="text-[11px] leading-4 text-amber-500"
            data-unsandboxed-note
          >
            Not sandboxed. Commands run with your full rights.
          </p>
        ) : null}
        <dl className="flex flex-col">
          <Fact label="Mode" value={sandbox.mode} />
          {sandbox.profile ? (
            <Fact label="Profile" value={sandbox.profile} />
          ) : null}
          <Fact label="Writes" value={sandbox.writable} />
          <Fact label="Network" value={sandbox.network} />
        </dl>
        <div>
          <h4 className="py-1 text-[11px] text-content/45">Where data goes</h4>
          <ul className="flex flex-col" data-destinations>
            {view.destinations.map((item) => (
              <DestinationRow key={`${item.kind}:${item.label}`} item={item} />
            ))}
          </ul>
          {view.notPrivateBecause ? (
            <p className="pt-1 text-[11px] leading-4 text-content/45">
              Not private: {view.notPrivateBecause}.
            </p>
          ) : null}
        </div>
        {view.networkLog.length ? (
          <div>
            <h4 className="py-1 text-[11px] text-content/45">
              Network requests
            </h4>
            <ul className="flex flex-col" data-network-log>
              {view.networkLog.map((entry) => (
                <li
                  key={entry.blockId}
                  className="flex min-w-0 gap-2 py-0.5 text-[12px]"
                >
                  <span className="min-w-0 truncate text-content/85">
                    {entry.host}
                  </span>
                  <span className="shrink-0 text-content/45">
                    {entry.protocol}
                  </span>
                  <span className="ml-auto shrink-0 text-content/60">
                    {DECISION_LABEL[entry.decided ?? "pending"]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="text-[11px] leading-4 text-content/40">
          What the harness reports. The firewall rule is the guarantee.
        </p>
      </div>
    </PanelSection>
  );
}
