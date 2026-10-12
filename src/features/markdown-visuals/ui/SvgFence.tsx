import { useEffect, useState, type ReactNode } from "react";

/** Larger drawings stay as source; an `<img>` of megabytes helps nobody. */
export const MAX_SVG_FENCE_BYTES = 512 * 1024;

/**
 * A fenced `svg` block drawn as an image (#40).
 *
 * The SVG goes through a blob URL into `<img>`. In that context the webview
 * runs no script and fetches nothing the drawing references, so this is safe
 * for any reply, inbox content from strangers included. A text-only model
 * with no tools can still draw this way.
 *
 * `source` is the normal code block, shown while the fence streams, when the
 * drawing does not parse, and when you ask for it.
 */
export function SvgFence({
  code,
  incomplete,
  source,
}: {
  code: string;
  incomplete: boolean;
  source: ReactNode;
}) {
  const [showSource, setShowSource] = useState(false);
  const [broken, setBroken] = useState(false);
  const drawable =
    !incomplete && looksLikeSvg(code) && code.length <= MAX_SVG_FENCE_BYTES;
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    setBroken(false);
    if (!drawable) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(
      new Blob([code], { type: "image/svg+xml" }),
    );
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [code, drawable]);

  if (!drawable || broken || !url) return <>{source}</>;

  return (
    <div className="markdown-visual" data-markdown-visual="svg" dir="ltr">
      {showSource ? (
        source
      ) : (
        <div className="markdown-visual-canvas">
          <img
            src={url}
            alt="Drawing from the reply"
            draggable={false}
            onError={() => setBroken(true)}
          />
        </div>
      )}
      <div className="markdown-visual-bar">
        <span>SVG</span>
        <button type="button" onClick={() => setShowSource((value) => !value)}>
          {showSource ? "Show drawing" : "Show source"}
        </button>
      </div>
    </div>
  );
}

/** A cheap check before handing text to the image decoder. */
export function looksLikeSvg(code: string): boolean {
  const text = code.trimStart().replace(/^<\?xml[^>]*>\s*/i, "");
  return /^(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text) && /<\/svg>\s*$/i.test(code.trimEnd());
}
