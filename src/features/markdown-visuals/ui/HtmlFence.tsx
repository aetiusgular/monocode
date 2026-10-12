import { useState, type ReactNode } from "react";
import { SandboxFrame } from "../../sandbox-frame/ui/SandboxFrame";

/**
 * A fenced `html` block with a "Render" button (#40). The page opens in the
 * sandboxed frame (F5): its scripts run, its fetches are blocked, and it has
 * no way into the app.
 *
 * `allowRender` is false for content written by strangers (inbox issues and
 * pull requests). There the block stays code, with no button.
 */
export function HtmlFence({
  code,
  incomplete,
  allowRender,
  source,
}: {
  code: string;
  incomplete: boolean;
  allowRender: boolean;
  source: ReactNode;
}) {
  const [rendered, setRendered] = useState(false);
  if (!allowRender || incomplete || !code.trim()) return <>{source}</>;
  return (
    <div className="markdown-visual" data-markdown-visual="html" dir="ltr">
      {rendered ? (
        <div className="markdown-visual-frame">
          <SandboxFrame html={code} title="HTML from the reply" className="h-full" />
        </div>
      ) : (
        source
      )}
      <div className="markdown-visual-bar">
        <span>{rendered ? "Rendered in a sandbox, no network" : "HTML"}</span>
        <button type="button" onClick={() => setRendered((value) => !value)}>
          {rendered ? "Show source" : "Render"}
        </button>
      </div>
    </div>
  );
}
