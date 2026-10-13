import type { ApprovalDecision } from "../../../integrations/harness/core/types";
import type { Block } from "../../sessions/model/session";
import { NO_SITE_NAMED, NOT_A_WEB_PAGE } from "../model/browserTools";
import {
  rememberSiteRule,
  type SiteDecision,
  type SiteScope,
} from "../model/siteRules";

type Site = NonNullable<NonNullable<Block["approval"]>["site"]>;

export type SiteRuleWriter = (
  scope: SiteScope,
  owner: string,
  host: string,
  decision: SiteDecision,
) => boolean;

const BUTTON =
  "rounded-md bg-content/10 px-2.5 py-0.5 text-[11px] text-content/80 hover:bg-content/20";

/**
 * The card for a browser tool that asks to open a site: the host as plain
 * text, then Allow once, Always for this chat, Always for this project, and
 * Never. A rule is saved before the answer goes out. A page that is not an
 * http(s) address gets Allow once and Deny only, since no rule can name it.
 */
export function SiteControls({
  requestId,
  site,
  onApproval,
  remember = rememberSiteRule,
}: {
  requestId: number;
  site: Site;
  onApproval: (requestId: number, decision: ApprovalDecision) => void;
  remember?: SiteRuleWriter;
}) {
  if (site.fetch)
    return (
      <FetchControls
        requestId={requestId}
        site={site}
        fetch={site.fetch}
        onApproval={onApproval}
        remember={remember}
      />
    );
  if (site.code)
    return (
      <CodeSiteControls
        requestId={requestId}
        site={site}
        onApproval={onApproval}
      />
    );
  const ruleable = site.host !== NOT_A_WEB_PAGE && site.ruleable !== false;
  const keep = (scope: SiteScope, decision: SiteDecision) => {
    const owner = scope === "chat" ? site.chatKey : site.projectKey;
    if (owner) remember(scope, owner, site.host, decision);
    onApproval(requestId, decision === "always" ? "allow" : "deny");
  };
  return (
    <div data-browser-site className="mt-1.5 text-[11px]">
      <div className="break-all text-content/60">
        {site.server} wants to open{" "}
        <span className="font-mono text-content/80">{site.host}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-md bg-content px-2.5 py-0.5 text-[11px] text-background-base hover:bg-content/80"
          onClick={() => onApproval(requestId, "allow")}
        >
          Allow once
        </button>
        {ruleable && site.chatKey ? (
          <button
            type="button"
            className={BUTTON}
            onClick={() => keep("chat", "always")}
          >
            Always for this chat
          </button>
        ) : null}
        {ruleable && site.projectKey ? (
          <button
            type="button"
            className={BUTTON}
            onClick={() => keep("project", "always")}
          >
            Always for this project
          </button>
        ) : null}
        {ruleable && site.chatKey ? (
          <button
            type="button"
            className={BUTTON}
            onClick={() => keep("chat", "never")}
          >
            Never
          </button>
        ) : (
          <button
            type="button"
            className={BUTTON}
            onClick={() => onApproval(requestId, "deny")}
          >
            Deny
          </button>
        )}
      </div>
    </div>
  );
}

const PLAIN =
  "max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-content/5 px-2 py-1 font-mono text-[11px] text-content/80";

/**
 * The card for a web fetch, as the Claude desktop app shows it: the site, the
 * full address and the prompt as plain text, then Decline, Always allow for
 * this website (kept on this chat) and Allow once. A fetch with no readable
 * address offers no rule.
 */
function FetchControls({
  requestId,
  site,
  fetch,
  onApproval,
  remember,
}: {
  requestId: number;
  site: Site;
  fetch: { url: string; prompt: string };
  onApproval: (requestId: number, decision: ApprovalDecision) => void;
  remember: SiteRuleWriter;
}) {
  const ruleable =
    site.ruleable !== false &&
    site.host !== NOT_A_WEB_PAGE &&
    site.host !== NO_SITE_NAMED &&
    !!site.chatKey;
  return (
    <div data-web-fetch className="mt-1.5 text-[11px]">
      <div className="text-content/70">Claude wants to fetch a web page</div>
      <div className="mt-1 break-all text-content/60">
        Website <span className="font-mono text-content/80">{site.host}</span>
      </div>
      <div className="mt-1 text-content/50">Address</div>
      <div data-web-fetch-url className={PLAIN}>
        {fetch.url}
      </div>
      {fetch.prompt ? (
        <>
          <div className="mt-1 text-content/50">Prompt</div>
          <div data-web-fetch-prompt className={PLAIN}>
            {fetch.prompt}
          </div>
        </>
      ) : null}
      <div className="mt-1.5 flex flex-wrap gap-2">
        <button
          type="button"
          className={BUTTON}
          onClick={() => onApproval(requestId, "deny")}
        >
          Decline
        </button>
        {ruleable ? (
          <button
            type="button"
            className={BUTTON}
            title="Allow fetches from this website for the rest of this chat, also after a restart. Other websites still ask."
            onClick={() => {
              // The rule goes first, so the next fetch in this turn sees it.
              remember("chat", site.chatKey!, site.host, "always");
              onApproval(requestId, "allow");
            }}
          >
            Always allow for this website
          </button>
        ) : null}
        <button
          type="button"
          className="rounded-md bg-content px-2.5 py-0.5 text-[11px] text-background-base hover:bg-content/80"
          onClick={() => onApproval(requestId, "allow")}
        >
          Allow once
        </button>
      </div>
    </div>
  );
}

/**
 * The card for a browser tool that runs code. Code can open any site, so no
 * rule may answer it: Allow once and Decline only. The sites its code names
 * are listed as plain text.
 */
function CodeSiteControls({
  requestId,
  site,
  onApproval,
}: {
  requestId: number;
  site: Site;
  onApproval: (requestId: number, decision: ApprovalDecision) => void;
}) {
  const hosts = site.hosts ?? [];
  return (
    <div data-browser-site data-browser-code className="mt-1.5 text-[11px]">
      <div className="break-all text-content/60">
        {hosts.length === 0 ? (
          <>
            {site.server} wants to run code in the browser. No website named in
            this call.
          </>
        ) : (
          <>
            {site.server} wants to run code in the browser on{" "}
            <span className="font-mono text-content/80">
              {hosts.join(", ")}
            </span>
            . The code can open other sites too.
          </>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-md bg-content px-2.5 py-0.5 text-[11px] text-background-base hover:bg-content/80"
          onClick={() => onApproval(requestId, "allow")}
        >
          Allow once
        </button>
        <button
          type="button"
          className={BUTTON}
          onClick={() => onApproval(requestId, "deny")}
        >
          Decline
        </button>
      </div>
    </div>
  );
}
