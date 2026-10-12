import type { ApprovalDecision } from "../../../integrations/harness/core/types";
import type { Block } from "../../sessions/model/session";
import { NOT_A_WEB_PAGE } from "../model/browserTools";
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
  const ruleable = site.host !== NOT_A_WEB_PAGE;
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
