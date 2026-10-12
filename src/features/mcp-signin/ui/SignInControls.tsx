import { openUrl } from "@tauri-apps/plugin-opener";
import type { ApprovalDecision } from "../../../integrations/harness/core/types";
import type { Block } from "../../sessions/model/session";

type SignIn = NonNullable<NonNullable<Block["approval"]>["signIn"]>;

/** Opens a page in the system browser. Replaced in tests. */
export type PageOpener = (url: string) => Promise<void>;

const systemBrowser: PageOpener = (url) => openUrl(url);

/**
 * The card for an MCP server's browser sign-in request. Everything on it is
 * the server's text, shown as plain text: the server's name, its message and
 * the full address, so the user sees where the page goes before opening it.
 * The page opens only on "Open sign-in page", in the system browser, never in
 * MonoCode. "Cancel" declines.
 */
export function SignInControls({
  requestId,
  signIn,
  onApproval,
  open = systemBrowser,
}: {
  requestId: number;
  signIn: SignIn;
  onApproval: (requestId: number, decision: ApprovalDecision) => void;
  open?: PageOpener;
}) {
  const url = signIn.url;
  return (
    <div data-mcp-signin className="mt-1.5 text-[11px]">
      {signIn.message ? (
        <div className="break-words text-content/70">
          From {signIn.server}: {signIn.message}
        </div>
      ) : null}
      {url ? (
        <div className="mt-1 break-all font-mono text-content/60">{url}</div>
      ) : null}
      <div className="mt-1.5 flex gap-2">
        {url ? (
          <button
            type="button"
            data-mcp-signin-open
            className="rounded-md bg-content px-2.5 py-0.5 text-[11px] text-background-base hover:bg-content/80"
            onClick={() => {
              void open(url)
                .then(() => onApproval(requestId, "allow"))
                .catch(() => onApproval(requestId, "deny"));
            }}
          >
            Open sign-in page
          </button>
        ) : null}
        <button
          type="button"
          data-mcp-signin-cancel
          className="rounded-md bg-content/10 px-2.5 py-0.5 text-[11px] text-content/70 hover:bg-content/20"
          onClick={() => onApproval(requestId, "deny")}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
